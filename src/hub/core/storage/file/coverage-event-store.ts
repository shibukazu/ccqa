import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { CoverageEventStore } from "../types.ts";
import { assertSafeName, serialize, writeBytes } from "./fs-helpers.ts";
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
 * failing, and the prune's full rewrite goes through the atomic path.
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
    const raw = await readRaw(path);
    const state: StreamState = {
      nextSeq: 1,
      count: 0,
      bytes: Buffer.byteLength(raw),
      oldestAt: null,
      endsWithNewline: raw === "" || raw.endsWith("\n"),
    };
    for (const rawLine of raw.split("\n")) {
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

    const lines = await readLines(path);
    const cutoff = now - retentionMs;
    const fresh = lines.filter((l) => l.at >= cutoff);
    const keep = overCount ? Math.max(0, maxEvents - pruneBatch) : maxEvents;
    let kept = fresh.length > keep ? fresh.slice(fresh.length - keep) : fresh;
    if (overBytes) kept = newestWithinBytes(kept, pruneBytesTarget);

    const encoded = new TextEncoder().encode(
      kept.map((l) => JSON.stringify(l)).join("\n") + (kept.length > 0 ? "\n" : ""),
    );
    await writeBytes(path, encoded);
    const dropped = state.count - kept.length;
    state.count = kept.length;
    state.bytes = encoded.byteLength;
    state.oldestAt = kept[0]?.at ?? null;
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

/** The longest tail of `lines` whose serialized size (newlines included) fits in `budget`. */
function newestWithinBytes(lines: StoredLine[], budget: number): StoredLine[] {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    total += Buffer.byteLength(JSON.stringify(lines[i])) + 1;
    if (total > budget) return lines.slice(i + 1);
  }
  return lines;
}

async function readRaw(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
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
    if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) throw err;
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Every parseable line of the log; partial or corrupt lines are silently omitted (the read side counts them). */
async function readLines(path: string): Promise<StoredLine[]> {
  const lines: StoredLine[] = [];
  for await (const rawLine of streamLines(path)) {
    const line = parseLine(rawLine);
    if (line !== null) lines.push(line);
  }
  return lines;
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
