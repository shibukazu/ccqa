import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Reads the steps of a Playwright `trace.zip` after ccqa has run a generated
 * Playwright test with `--trace on`. The trace format is
 * public but Playwright ships no reader library for it outside the `show
 * trace` UI, and pulling in a zip dependency for one consumer-side artefact
 * is not worth the supply-chain surface — the format is small enough (local
 * + central directory, stored/deflate only) to read with `node:zlib` alone.
 *
 * `readZip` walks the central directory rather than the local file headers:
 * a streaming zip writer (which is what Playwright's tracing uses) often
 * leaves the local header's size fields zeroed and appends a data
 * descriptor instead, so the central directory is the only place sizes are
 * guaranteed correct. It decompresses nothing until an entry is read: a
 * capture needs only the `.trace` members.
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

/** A DOM snapshot the trace recorded around one browser call. */
export interface SnapshotRef {
  pageId: string;
  /** `before@<callId>` / `after@<callId>`, as the trace names it. */
  name: string;
  viewport?: { width: number; height: number };
}

/** A call the test runner recorded, with the snapshots that show its two ends. */
export interface TraceStep {
  title: string;
  /**
   * What went wrong inside the step, when something did. Carried because it is
   * the only thing that tells an evidence table which step of a failed run was
   * the one that failed.
   */
  error?: string;
  /** Before its first browser call inside it. */
  before?: SnapshotRef;
  /** After its last browser call inside it — the page its assertions saw. */
  after?: SnapshotRef;
}

interface TraceCall {
  title: string;
  startTime: number;
  endTime?: number;
  /** The enclosing call: a step's parent step, or the step a browser call ran in. */
  parent?: string;
  error?: string;
  /** Set only on browser calls; the test runner's own calls have none. */
  pageId?: string;
  beforeSnapshot?: string;
  afterSnapshot?: string;
}

/**
 * The calls one trace holds, each runner-side call with the DOM at its two
 * boundaries: the before-snapshot of the first Playwright call inside it and the
 * after-snapshot of the last, whatever kind of call (action, wait, assertion).
 * Nothing the test did not itself wait for is shown — a step ending in a click
 * shows the DOM right after the click. Calls count at any depth, so a step
 * nested in another counts toward both.
 *
 * A trace is JSON Lines; a corrupt or truncated line must not sink the whole
 * read, so parsing is best-effort per line. A browser call points at the
 * runner call it ran in through `stepId`; the runner calls chain through
 * `parentId`.
 */
export function parseTraceSteps(jsonl: string): TraceStep[] {
  const calls = new Map<string, TraceCall>();
  const viewports = new Map<string, { width: number; height: number }>();

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
    const callId = event.callId;

    if (event.type === "frame-snapshot") {
      const snapshot = event.snapshot as Record<string, unknown> | undefined;
      const viewport = snapshot?.viewport as { width?: unknown; height?: unknown } | undefined;
      if (
        typeof snapshot?.snapshotName === "string" &&
        snapshot.isMainFrame !== false &&
        typeof viewport?.width === "number" &&
        typeof viewport.height === "number" &&
        !viewports.has(snapshot.snapshotName)
      ) {
        viewports.set(snapshot.snapshotName, { width: viewport.width, height: viewport.height });
      }
    } else if ((event.type === "before" || event.type === "action") && typeof callId === "string") {
      if (typeof event.startTime !== "number") continue;
      const stepId = typeof event.stepId === "string" && event.stepId !== callId ? event.stepId : undefined;
      const parent = stepId ?? (typeof event.parentId === "string" ? event.parentId : undefined);
      calls.set(callId, {
        title: titleOf(event),
        startTime: event.startTime,
        ...(parent !== undefined ? { parent } : {}),
        ...(typeof event.pageId === "string" ? { pageId: event.pageId } : {}),
        ...(typeof event.beforeSnapshot === "string" ? { beforeSnapshot: event.beforeSnapshot } : {}),
      });
    }
    if ((event.type === "after" || event.type === "action") && typeof callId === "string") {
      const call = calls.get(callId);
      if (call === undefined) continue;
      if (typeof event.endTime === "number") call.endTime = event.endTime;
      if (typeof event.afterSnapshot === "string") call.afterSnapshot = event.afterSnapshot;
      Object.assign(call, errorOf(event));
    }
  }

  const steps = new Map<TraceCall, TraceStep & { first?: TraceCall; last?: TraceCall }>();
  for (const call of calls.values()) {
    if (call.pageId !== undefined) continue;
    steps.set(call, { title: call.title, ...(call.error !== undefined ? { error: call.error } : {}) });
  }
  for (const call of calls.values()) {
    if (call.pageId === undefined) continue;
    const seen = new Set<string>();
    for (let id = call.parent; id !== undefined && !seen.has(id); id = calls.get(id)?.parent) {
      seen.add(id);
      const step = steps.get(calls.get(id)!);
      if (step === undefined) continue;
      if (call.beforeSnapshot !== undefined && (!step.first || call.startTime < step.first.startTime)) {
        step.first = call;
      }
      if (
        call.afterSnapshot !== undefined &&
        call.endTime !== undefined &&
        (!step.last || call.endTime > step.last.endTime!)
      ) {
        step.last = call;
      }
    }
  }

  const ref = (call: TraceCall, name: string): SnapshotRef => {
    const viewport = viewports.get(name);
    return { pageId: call.pageId!, name, ...(viewport ? { viewport } : {}) };
  };
  return [...steps.entries()]
    .sort(([a], [b]) => a.startTime - b.startTime)
    .map(([, { first, last, ...step }]) => ({
      ...step,
      ...(first ? { before: ref(first, first.beforeSnapshot!) } : {}),
      ...(last ? { after: ref(last, last.afterSnapshot!) } : {}),
    }));
}

/** The joined `.trace` members of an archive: the runner's steps and the browser's calls are separate files. */
export async function readTraceJsonl(archive: string): Promise<string> {
  const entries = await readZip(archive);
  return entries.names
    .filter((name) => name.endsWith(".trace"))
    .map((name) => entries.read(name)?.toString("utf8") ?? "")
    .join("\n");
}

/** The call's failure message, in whichever shape the trace recorded it. */
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
