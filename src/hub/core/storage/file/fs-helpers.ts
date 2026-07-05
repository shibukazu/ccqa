import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** Read and JSON-parse a file, returning `null` when it doesn't exist. Malformed JSON throws. */
export async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`corrupt JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write `data` to a temp file in the same directory, then atomically rename it
 * into place, so a concurrent reader only ever observes the old file or the
 * fully-written new one — never the empty/partial window a plain
 * truncate-then-write leaves open (e.g. a `putActualCause` writing a run's
 * triage file while an API request reads it). The temp file lives in the same
 * directory as its target to keep the rename on one filesystem, where it is
 * atomic.
 */
async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Write `value` as pretty JSON, creating parent directories as needed. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

/**
 * Per-path serialization for read-modify-write JSON updates. Two concurrent
 * `updateJson` calls on the same path (e.g. two `putActualCause` calls racing
 * on the same run's triage file) would otherwise both read the same starting
 * state and the second writer's change would silently clobber the first's —
 * this queues the second call's read until the first's write has landed, so
 * updates apply in the order they were issued rather than racing. Scoped by
 * path (a `Map` of chained promises), not globally, so unrelated records still
 * update concurrently.
 */
const updateChains = new Map<string, Promise<unknown>>();

export async function updateJson<T>(path: string, mutate: (current: T | null) => T): Promise<T> {
  const previous = updateChains.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => {}) // a prior failed update must not wedge the chain for later callers
    .then(async () => {
      const current = await readJson<T>(path);
      const updated = mutate(current);
      await writeJson(path, updated);
      return updated;
    });
  updateChains.set(path, next);
  try {
    return await next;
  } finally {
    if (updateChains.get(path) === next) updateChains.delete(path);
  }
}

/** Read a raw file, returning `null` when it doesn't exist. */
export async function readBytesOrNull(path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await atomicWrite(path, bytes);
}

/** List entry names (files or dirs) directly under `dir`, or `[]` when it doesn't exist. */
export async function listDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Subdirectory names directly under `dir`, or `[]` when it doesn't exist.
 * Skips files and dot-entries so stray filesystem litter (e.g. a Finder
 * `.DS_Store`) never surfaces as a record id or project name.
 */
export async function listSubdirsOrEmpty(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** Every file path under `dir`, relative to `dir`, posix-separated. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(dir, abs).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out;
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}
