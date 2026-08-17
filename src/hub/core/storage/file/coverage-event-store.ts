import { appendFile, mkdir, readFile } from "node:fs/promises";
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
  oldestAt: number | null;
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
  const retentionMs = caps?.retentionMs ?? COVERAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const pruneBatch = Math.min(PRUNE_COUNT_BATCH, Math.max(1, Math.floor(maxEvents / 10)));
  const states = new Map<string, StreamState>();

  async function loadState(project: string, path: string): Promise<StreamState> {
    const cached = states.get(project);
    if (cached) return cached;
    // Seq resumes from the highest stored one, not the line count: retention
    // drops lines from the head, and a seq must never be reissued — the
    // resolve cache keys off it (events.ts).
    const state: StreamState = { nextSeq: 1, count: 0, oldestAt: null };
    for (const line of await readLines(path)) {
      if (line.seq >= state.nextSeq) state.nextSeq = line.seq + 1;
      state.count += 1;
      if (state.oldestAt === null || line.at < state.oldestAt) state.oldestAt = line.at;
    }
    states.set(project, state);
    return state;
  }

  async function pruneIfDue(project: string, path: string, state: StreamState, now: number): Promise<void> {
    const overCount = state.count > maxEvents;
    const overAge = state.oldestAt !== null && state.oldestAt < now - retentionMs - PRUNE_AGE_SLACK_MS;
    if (!overCount && !overAge) return;

    const lines = await readLines(path);
    const cutoff = now - retentionMs;
    const fresh = lines.filter((l) => l.at >= cutoff);
    const keep = overCount ? Math.max(0, maxEvents - pruneBatch) : maxEvents;
    const kept = fresh.length > keep ? fresh.slice(fresh.length - keep) : fresh;

    await writeBytes(
      path,
      new TextEncoder().encode(kept.map((l) => JSON.stringify(l)).join("\n") + (kept.length > 0 ? "\n" : "")),
    );
    const dropped = state.count - kept.length;
    state.count = kept.length;
    state.oldestAt = kept[0]?.at ?? null;
    if (dropped > 0) {
      console.warn(
        `hub: coverage inbox for "${project}": dropped ${dropped} events past retention ` +
          `(${maxEvents} events / ${Math.round(retentionMs / 86_400_000)} days)`,
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
        await appendFile(path, JSON.stringify(line) + "\n");
        state.nextSeq += 1;
        state.count += 1;
        if (state.oldestAt === null) state.oldestAt = stamp.at;
        await pruneIfDue(project, path, state, stamp.at);
        return stamp;
      });
    },

    async read(project, sinceSeq) {
      assertSafeName(project, "project");
      const path = coverageEventsPath(root, project);
      // Answered from the file alone (no in-memory state): a read races only
      // against the append-in-flight partial line, which parseLine already
      // treats as skipped.
      const raw = await readRaw(path);
      const entries: { seq: number; at: number; payload: Uint8Array }[] = [];
      let lastSeq = 0;
      let skipped = 0;
      for (const rawLine of nonEmptyLines(raw)) {
        const line = parseLine(rawLine);
        if (line === null) {
          skipped += 1;
          continue;
        }
        if (line.seq > lastSeq) lastSeq = line.seq;
        if (line.seq <= sinceSeq) continue;
        entries.push({ seq: line.seq, at: line.at, payload: new Uint8Array(Buffer.from(line.payload, "base64")) });
      }
      entries.sort((a, b) => a.seq - b.seq);
      return { entries, lastSeq, skipped };
    },
  };
}

async function readRaw(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function nonEmptyLines(raw: string): string[] {
  return raw.split("\n").filter((l) => l !== "");
}

/** Every parseable line of the log; partial or corrupt lines are silently omitted (the read side counts them). */
async function readLines(path: string): Promise<StoredLine[]> {
  const lines: StoredLine[] = [];
  for (const rawLine of nonEmptyLines(await readRaw(path))) {
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
