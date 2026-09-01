import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { CoverageEventStore } from "../types.ts";
import { assertSafeName, isNotFound, serialize } from "./fs-helpers.ts";
import { coverageEventsPath } from "./paths.ts";

/**
 * Hard cap on stored coverage events per project. The stream loses its oldest
 * events first once it grows past this — a resolve only ever reads back as far
 * as the runs still being interpreted, while an unbounded stream would make
 * every read (and the prune itself) grow without limit.
 */
export const COVERAGE_MAX_EVENTS = 200_000;

/**
 * Hard cap on a project's stored stream in bytes. Half of V8's ~512 MB string
 * limit: past that, `readFile(path, "utf8")` itself throws, taking down not
 * just reads but the prune and the state load — the stream must be cut well
 * before it can grow anywhere near the point where it stops being repairable.
 */
export const COVERAGE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * How long a coverage event is kept. Two weeks comfortably outlives the window
 * in which anything still resolves the stream (a run plus its consumers) —
 * the retention bound the inbox promises its payloads expire with (ADR-0022).
 */
export const COVERAGE_RETENTION_DAYS = 14;

// Prune amortization. Cutting back to exactly the cap on every append would
// rewrite the whole file per event once the cap is reached, so an over-cap
// prune cuts one batch below it; an age prune only fires once the oldest
// event has overstayed by the slack, so events may outlive the retention
// bound by up to that hour.
const PRUNE_COUNT_BATCH = 1_000;
const PRUNE_AGE_SLACK_MS = 60 * 60 * 1000;

/** Retention bounds, overridable so tests can exercise the prune cheaply. */
export interface CoverageRetentionCaps {
  maxEvents: number;
  maxBytes: number;
  retentionMs: number;
}

/** What one stored line holds: the stamp in the clear, the payload opaque. */
interface StoredLine {
  seq: number;
  at: number;
  /** Base64 of the encrypted payload bytes the caller handed `append`. */
  payload: string;
}

/**
 * What `append` must know without re-reading the file: the next stamp and
 * enough to decide whether a prune is due. Loaded by scanning the file once,
 * then maintained in memory — correct because appends are serialized per path
 * and the hub is a single process.
 */
interface StreamState {
  nextSeq: number;
  count: number;
  /** Size of the file, tracked so the byte cap never has to re-stat or re-read to fire. */
  bytes: number;
  oldestAt: number | null;
  /** False when the file ends in a partial line (an append died mid-write); see `append`. */
  endsWithNewline: boolean;
}

/**
 * Coverage-inbox storage: `coverage/<project>/events.jsonl`, one stamped
 * event per line, appended in place (not atomic-rewritten — an append must
 * not cost the whole stream). A reader can therefore observe a partial final
 * line mid-append; the read side counts such lines as skipped rather than
 * failing, and the prune's full rewrite goes through a temp file + rename.
 */
export function createFileCoverageEventStore(
  root: string,
  caps?: Partial<CoverageRetentionCaps>,
): CoverageEventStore {
  const maxEvents = caps?.maxEvents ?? COVERAGE_MAX_EVENTS;
  const maxBytes = caps?.maxBytes ?? COVERAGE_MAX_BYTES;
  const retentionMs = caps?.retentionMs ?? COVERAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruneBatch = Math.min(PRUNE_COUNT_BATCH, Math.max(1, Math.floor(maxEvents / 10)));
  // Same amortization idea as the count batch: an over-bytes prune cuts a
  // tenth below the cap, so the next append can't immediately re-trigger it.
  const pruneBytesTarget = maxBytes - Math.max(1, Math.floor(maxBytes / 10));
  const states = new Map<string, StreamState>();

  async function loadState(project: string, path: string): Promise<StreamState> {
    const cached = states.get(project);
    if (cached) return cached;
    // Seq resumes from the highest stored one, not the line count: retention
    // drops lines from the head, and a seq must never be reissued — the
    // resolve cache keys off it (events.ts).
    //
    // Never hold the whole stream in memory: grown to its caps it no longer
    // fits the hub's heap.
    const tail = await statTail(path);
    const state: StreamState = {
      nextSeq: 1,
      count: 0,
      bytes: tail?.size ?? 0,
      oldestAt: null,
      endsWithNewline: tail?.endsWithNewline ?? true,
    };
    for await (const rawLine of streamLines(path)) {
      const line = parseLine(rawLine);
      if (line === null) continue;
      if (line.seq >= state.nextSeq) state.nextSeq = line.seq + 1;
      state.count += 1;
      if (state.oldestAt === null || line.at < state.oldestAt) state.oldestAt = line.at;
    }
    states.set(project, state);
    return state;
  }

  async function pruneIfDue(project: string, path: string, state: StreamState, now: number): Promise<void> {
    const overCount = state.count > maxEvents;
    const overBytes = state.bytes > maxBytes;
    const overAge = state.oldestAt !== null && state.oldestAt < now - retentionMs - PRUNE_AGE_SLACK_MS;
    if (!overCount && !overBytes && !overAge) return;

    // Two streamed passes, so the stream's payloads never sit in memory at
    // once. Pass 1 collects only each fresh line's serialized size — the
    // keep/drop decision needs ages and sizes, never the payloads.
    const cutoff = now - retentionMs;
    const freshSizes: number[] = [];
    for await (const line of streamFreshLines(path, cutoff)) {
      freshSizes.push(Buffer.byteLength(JSON.stringify(line)) + 1);
    }
    const keep = overCount ? Math.max(0, maxEvents - pruneBatch) : maxEvents;
    let firstKept = freshSizes.length > keep ? freshSizes.length - keep : 0;
    if (overBytes) firstKept = firstWithinBytes(freshSizes, firstKept, pruneBytesTarget);

    // Pass 2 rewrites the survivors through a temp file (the temp+rename
    // shape of fs-helpers' atomicWrite, streamed instead of buffered).
    // `pipeline` owns backpressure and error propagation: a failed write
    // rejects here and never lets a truncated file reach the rename.
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    let keptCount = 0;
    let keptBytes = 0;
    let oldestKeptAt: number | null = null;
    try {
      await pipeline(async function* () {
        let freshIdx = 0;
        for await (const line of streamFreshLines(path, cutoff)) {
          freshIdx += 1;
          if (freshIdx <= firstKept) continue;
          const text = JSON.stringify(line) + "\n";
          keptCount += 1;
          keptBytes += Buffer.byteLength(text);
          if (oldestKeptAt === null) oldestKeptAt = line.at;
          yield text;
        }
      }, createWriteStream(tmp, { encoding: "utf8" }));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await rename(tmp, path);

    const dropped = state.count - keptCount;
    state.count = keptCount;
    state.bytes = keptBytes;
    state.oldestAt = oldestKeptAt;
    state.endsWithNewline = true;
    if (dropped > 0) {
      console.warn(
        `hub: coverage inbox for "${project}": dropped ${dropped} events past retention ` +
          `(${maxEvents} events / ${Math.round(maxBytes / 1_048_576)} MiB / ` +
          `${Math.round(retentionMs / 86_400_000)} days)`,
      );
    }
  }

  return {
    async append(project, payload) {
      assertSafeName(project, "project");
      const path = coverageEventsPath(root, project);
      // Serialized per path so two appends can't interleave their writes or
      // both claim the same seq; the prune joins the same chain so it can't
      // rewrite the file underneath a concurrent append.
      return await serialize(path, async () => {
        const state = await loadState(project, path);
        const stamp = { seq: state.nextSeq, at: Date.now() };
        const line: StoredLine = { ...stamp, payload: Buffer.from(payload).toString("base64") };
        await mkdir(dirname(path), { recursive: true });
        // A crashed append can leave a partial line with no trailing newline;
        // appending onto it would weld two events into one unparseable line.
        // Starting on a fresh line sacrifices only the fragment.
        const text = (state.endsWithNewline ? "" : "\n") + JSON.stringify(line) + "\n";
        await appendFile(path, text);
        state.nextSeq += 1;
        state.count += 1;
        state.bytes += Buffer.byteLength(text);
        state.endsWithNewline = true;
        if (state.oldestAt === null) state.oldestAt = stamp.at;
        await pruneIfDue(project, path, state, stamp.at);
        return stamp;
      });
    },

    async scan(project, sinceSeq, visit) {
      assertSafeName(project, "project");
      const path = coverageEventsPath(root, project);
      const now = Date.now();
      // Retention must not depend on appends still happening — a stream
      // nothing writes to anymore would otherwise keep its events forever.
      // The prune joins the append chain; the read below stays outside it,
      // racing only against an append-in-flight partial line, which parseLine
      // already treats as skipped.
      await serialize(path, async () => {
        await pruneIfDue(project, path, await loadState(project, path), now);
      });
      const cutoff = now - retentionMs;
      let lastSeq = 0;
      let skipped = 0;
      for await (const rawLine of streamLines(path)) {
        const line = parseLine(rawLine);
        if (line === null) {
          skipped += 1;
          continue;
        }
        if (line.seq > lastSeq) lastSeq = line.seq;
        if (line.seq <= sinceSeq) continue;
        // The prune amortizes with slack; the retention promise doesn't — an
        // event past the window is never served, rewritten away or not.
        if (line.at < cutoff) continue;
        visit({ seq: line.seq, at: line.at, payload: new Uint8Array(Buffer.from(line.payload, "base64")) });
      }
      return { lastSeq, skipped };
    },

    async currentSeq(project) {
      assertSafeName(project, "project");
      const cached = states.get(project);
      if (cached) return cached.nextSeq - 1;
      const path = coverageEventsPath(root, project);
      // Joins the append chain so this load can't race an append's own load
      // and leave two state objects claiming the same stream.
      const state = await serialize(path, () => loadState(project, path));
      return state.nextSeq - 1;
    },
  };
}

/** Size and trailing-newline state of the stream file, or null when it doesn't exist. */
async function statTail(path: string): Promise<{ size: number; endsWithNewline: boolean } | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return { size, endsWithNewline: true };
    const tail = Buffer.alloc(1);
    await fh.read(tail, 0, 1, size - 1);
    return { size, endsWithNewline: tail[0] === 0x0a };
  } finally {
    await fh.close();
  }
}

/** Retention-window lines only, in file order (= append order = seq order). */
async function* streamFreshLines(path: string, cutoff: number): AsyncGenerator<StoredLine> {
  for await (const rawLine of streamLines(path)) {
    const line = parseLine(rawLine);
    if (line !== null && line.at >= cutoff) yield line;
  }
}

/** Start of the longest suffix of `sizes` that fits `budget` (never below `lower`). */
function firstWithinBytes(sizes: number[], lower: number, budget: number): number {
  let total = 0;
  for (let i = sizes.length - 1; i >= lower; i -= 1) {
    total += sizes[i]!;
    if (total > budget) return i + 1;
  }
  return lower;
}

/**
 * The stream's non-empty lines, one at a time. Streamed rather than read as one
 * string because a project's stream is capped in the hundreds of megabytes, far
 * past what a reader can hold. Order is the file's, which is append order,
 * which is seq order — the prune rewrites a suffix and never reorders.
 */
async function* streamLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line !== "") yield line;
    }
  } catch (err) {
    // A stream nothing has written to yet is empty, not an error.
    if (!isNotFound(err)) throw err;
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseLine(rawLine: string): StoredLine | null {
  let value: unknown;
  try {
    value = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const line = value as Partial<StoredLine>;
  if (typeof line.seq !== "number" || typeof line.at !== "number" || typeof line.payload !== "string") return null;
  return { seq: line.seq, at: line.at, payload: line.payload };
}
