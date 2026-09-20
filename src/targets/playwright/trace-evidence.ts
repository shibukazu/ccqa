import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Recovers per-step screenshots from a Playwright `trace.zip` after ccqa has
 * run a generated Playwright test with `--trace on`. The trace format is
 * public but Playwright ships no reader library for it outside the `show
 * trace` UI, and pulling in a zip dependency for one consumer-side artefact
 * is not worth the supply-chain surface — the format is small enough (local
 * + central directory, stored/deflate only) to read with `node:zlib` alone.
 *
 * `readZip` walks the central directory rather than the local file headers:
 * a streaming zip writer (which is what Playwright's tracing uses) often
 * leaves the local header's size fields zeroed and appends a data
 * descriptor instead, so the central directory is the only place sizes are
 * guaranteed correct. It decompresses nothing until an entry is read: almost
 * every member of a trace archive is a screencast frame, and a capture reads
 * the `.trace` members plus the two frames that bracket each step.
 */

/** A zip archive's entries, each decompressed when it is read. */
export interface ZipArchive {
  /** Every entry's name, in central-directory order. */
  names: readonly string[];
  /**
   * One entry's bytes, or undefined when the archive holds no such name — or
   * holds it under a compression method this reader does not implement.
   */
  read(name: string): Buffer | undefined;
}

/** Where one entry's bytes are, and how they are packed. */
interface ZipEntry {
  offset: number;
  method: number;
  compressedSize: number;
}

const EOCD_SIGNATURE = 0x06054b50;
// The comment field trailing the EOCD record is at most 0xFFFF bytes, so the
// signature can never sit further back than that plus the record's own size.
const EOCD_SEARCH_WINDOW = 0xffff + 22;

/** A zip archive's directory, read up front. Stored (method 0) and deflate (method 8) only. */
export async function readZip(path: string): Promise<ZipArchive> {
  const buf = await readFile(path);
  const eocd = findEndOfCentralDirectory(buf, path);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buf.readUInt32LE(eocd + 16);
  // A zip64 archive signals an oversized entry count / offset with the
  // classic-format fields pinned to their max value; there is no partial
  // zip64 support worth the extra header variant here.
  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error(`${path} uses zip64, which this reader does not support`);
  }

  const entries = readCentralDirectory(buf, centralDirectoryOffset, entryCount);
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (entry === undefined) return undefined;
      return readLocalEntryData(buf, entry.offset, entry.method, entry.compressedSize) ?? undefined;
    },
  };
}

function findEndOfCentralDirectory(buf: Buffer, path: string): number {
  const searchStart = Math.max(0, buf.length - EOCD_SEARCH_WINDOW);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error(`${path}: not a zip archive (no end-of-central-directory record found)`);
}

function readCentralDirectory(
  buf: Buffer,
  offset: number,
  entryCount: number,
): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let pos = offset;
  for (let i = 0; i < entryCount; i++) {
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLength);

    entries.set(name, { offset: localHeaderOffset, method, compressedSize });

    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readLocalEntryData(
  buf: Buffer,
  offset: number,
  method: number,
  compressedSize: number,
): Buffer | null {
  const nameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = buf.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return inflateRawSync(compressed);
  return null; // an exotic method (e.g. bzip2) — skip rather than fail the whole archive
}

/** A frame the trace's screencast captured. */
export interface TraceFrame {
  sha1: string;
  timestamp: number;
}

/** A step the trace recorded, with the frames that bracket it. */
export interface TraceStep {
  title: string;
  startTime: number;
  endTime: number;
  /**
   * What went wrong inside the step, when something did. Carried because it is
   * the only thing that tells an evidence table which step of a failed run was
   * the one that failed — the frames alone read as a run that went fine.
   */
  error?: string;
}

interface PendingStep {
  title: string;
  startTime: number;
}

/**
 * The screencast frames and the `test.step` calls one trace file holds.
 *
 * A trace is JSON Lines, one event object per line; a corrupt or truncated
 * line must not sink the whole read, so parsing is best-effort per line.
 * Step events come in two shapes across Playwright versions — a `before`/
 * `after` pair sharing a `callId`, or a single merged `action` event — and
 * both are folded into the same `TraceStep` shape here so callers never see
 * the version skew.
 */
export function parseTraceEvents(jsonl: string): { frames: TraceFrame[]; steps: TraceStep[] } {
  const frames: TraceFrame[] = [];
  const steps: TraceStep[] = [];
  const pendingByCallId = new Map<string, PendingStep>();
  let maxTimestamp = -Infinity;

  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as Record<string, unknown>;

    for (const field of ["timestamp", "startTime", "endTime"]) {
      const value = event[field];
      if (typeof value === "number") maxTimestamp = Math.max(maxTimestamp, value);
    }

    const type = event.type;
    if (type === "screencast-frame") {
      if (typeof event.sha1 === "string" && typeof event.timestamp === "number") {
        frames.push({ sha1: event.sha1, timestamp: event.timestamp });
      }
    } else if (type === "action") {
      if (
        typeof event.callId === "string" &&
        typeof event.startTime === "number" &&
        typeof event.endTime === "number"
      ) {
        steps.push({
          title: titleOf(event),
          startTime: event.startTime,
          endTime: event.endTime,
          ...errorOf(event),
        });
      }
    } else if (type === "before") {
      if (typeof event.callId === "string" && typeof event.startTime === "number") {
        pendingByCallId.set(event.callId, { title: titleOf(event), startTime: event.startTime });
      }
    } else if (type === "after") {
      if (typeof event.callId === "string" && typeof event.endTime === "number") {
        const pending = pendingByCallId.get(event.callId);
        if (pending !== undefined) {
          pendingByCallId.delete(event.callId);
          steps.push({ ...pending, endTime: event.endTime, ...errorOf(event) });
        }
      }
    }
  }

  // A `before` whose `after` never arrived (truncated trace, crashed run) —
  // close it at the last timestamp on record so it still has an evidence window.
  for (const pending of pendingByCallId.values()) {
    steps.push({ ...pending, endTime: maxTimestamp });
  }

  // Both sorted here, once, rather than searched in order by each caller: a
  // trace merged from several `.trace` members arrives interleaved.
  frames.sort((a, b) => a.timestamp - b.timestamp);
  steps.sort((a, b) => a.startTime - b.startTime);
  return { frames, steps };
}

/** The step's failure message, in whichever shape the trace recorded it. */
function errorOf(event: Record<string, unknown>): { error?: string } {
  const error = event.error;
  if (typeof error === "string") return { error };
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return { error: message };
  }
  return {};
}

function titleOf(event: Record<string, unknown>): string {
  if (typeof event.apiName === "string") return event.apiName;
  if (typeof event.title === "string") return event.title;
  return "";
}

/**
 * The frame on screen at `time`: the last one captured at or before it, or —
 * when the step began before any frame was captured — the first frame after.
 * Null when the trace holds no frames at all. `frames` comes from
 * {@link parseTraceEvents}, which sorts them by timestamp.
 */
export function frameAt(frames: readonly TraceFrame[], time: number): TraceFrame | null {
  return frames.findLast((f) => f.timestamp <= time) ?? frames[0] ?? null;
}
