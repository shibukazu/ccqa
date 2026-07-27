import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Minimal ustar (POSIX tar) reader/writer, purpose-built for shipping a
 * report directory between `ccqa hub push` and the hub (and back out on
 * download). No external tar dependency: the only thing this ever unpacks is
 * a tarball this same module packed, so the format only needs to cover what a
 * report dir actually contains — regular files and directories. Symlinks,
 * hardlinks, and devices are rejected outright rather than silently
 * mishandled. Paths too long for ustar's 100+155 byte name split travel in a
 * pax extended header, which GNU tar and bsdtar both read, so a downloaded
 * bundle still extracts with the system tar.
 */

const BLOCK_SIZE = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

export interface TarEntry {
  /** Forward-slash path, relative to the archive root. */
  path: string;
  /** File contents. Absent for directory entries. */
  content?: Uint8Array;
  /** Unix file mode (permission bits only, e.g. 0o644 / 0o755). */
  mode: number;
}

/** Pack `entries` into a gzip-compressed ustar archive. */
export function packTarGz(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [i, entry] of entries.entries()) {
    blocks.push(...buildEntryBlocks(entry, i));
  }
  // Two 512-byte zero blocks mark the end of the archive.
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));
  return gzipSync(concat(blocks));
}

/**
 * The blocks for one entry: its header and content, preceded by a pax
 * extended header when the path does not fit ustar's name fields.
 *
 * A single path *component* can exceed the 100-byte name field on its own, so
 * no choice of split point helps — which is what happens as soon as a test
 * title is written in a language whose characters are 3 bytes each. Playwright
 * names its artifact directories after the test title, so this is ordinary
 * usage, not an edge case: before pax support, every failing non-ASCII-titled
 * spec was simply unpushable.
 */
function buildEntryBlocks(entry: TarEntry, index: number): Uint8Array[] {
  const isDir = entry.content === undefined;
  const path = isDir && !entry.path.endsWith("/") ? entry.path + "/" : entry.path;
  const blocks: Uint8Array[] = [];
  const split = splitPath(path);

  if (split === null) {
    // The real path travels in the pax record; the ustar fields carry a
    // truncated copy so a reader that ignores pax still gets a sane name
    // rather than a fabricated one.
    const record = paxPathRecord(path);
    blocks.push(
      buildUstarHeader({ name: `PaxHeaders/${index}`, prefix: "", mode: 0o644, size: record.length, typeflag: "x" }),
      record,
      padding(record.length),
    );
  }

  blocks.push(
    buildUstarHeader({
      ...(split ?? { name: truncateToFit(path), prefix: "" }),
      mode: entry.mode,
      size: entry.content?.length ?? 0,
      typeflag: isDir ? "5" : "0",
    }),
  );
  if (entry.content) {
    blocks.push(entry.content, padding(entry.content.length));
  }
  return blocks;
}

/**
 * A pax extended-header "path" record: `"<len> path=<value>\n"`, where
 * `<len>` counts its own digits too. Solved by iterating, since adding a
 * digit to the length can push the total across the next power of ten. The
 * only key this packer ever writes is "path", so it's baked in rather than
 * threaded through as a parameter nothing else supplies.
 */
function paxPathRecord(value: string): Uint8Array {
  const body = ` path=${value}\n`;
  const bodyLen = Buffer.byteLength(body, "utf8");
  let len = bodyLen + 1;
  while (Buffer.byteLength(String(len), "utf8") + bodyLen !== len) {
    len = Buffer.byteLength(String(len), "utf8") + bodyLen;
  }
  return new Uint8Array(Buffer.from(`${len}${body}`, "utf8"));
}

/**
 * `path` cut to the largest prefix that fits the ustar name field, never
 * splitting a multi-byte character. Only the pax fallback uses this, so it
 * need not be reversible.
 *
 * Cuts to `NAME_MAX` bytes directly rather than shrinking one character at a
 * time. A cut that lands mid-character leaves an incomplete trailing byte
 * sequence, which `toString("utf8")` renders as one or more U+FFFD — those
 * are then dropped, since they're a decoding artifact of the cut point, not
 * part of the path.
 */
function truncateToFit(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  if (bytes.length <= NAME_MAX) return path;
  return bytes.subarray(0, NAME_MAX).toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * Unpack a gzip-compressed ustar archive produced by `packTarGz` into
 * `destDir`. Rejects anything outside ustar's regular-file/directory subset,
 * and any path that would escape `destDir` (absolute paths, `..` segments) —
 * defense in depth even though the packer never emits either.
 */
export async function unpackTarGz(archive: Uint8Array, destDir: string): Promise<void> {
  const tar = gunzipSync(archive);
  let offset = 0;
  // Set by a pax extended header, consumed by the entry that follows it.
  let paxPath: string | null = null;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break; // end-of-archive marker
    offset += BLOCK_SIZE;

    const raw = parseHeader(header);
    const { size, mode, typeflag } = raw;

    if (typeflag === "x") {
      // The record carries the real path for the next entry, which the ustar
      // fields can only hold truncated.
      const record = tar.subarray(offset, offset + size);
      offset += blockAligned(size);
      paxPath = parsePaxPath(record);
      if (paxPath === null) {
        // The ustar fields only hold a truncated copy of the real path, and
        // truncated names collide between long siblings — writing one out
        // would silently put the wrong bytes in the wrong file. This packer
        // emitted the record, so an unreadable one is corruption, not a
        // format we should tolerate.
        throw new Error("tar entry has a pax extended header with no readable path");
      }
      continue;
    }

    const path = paxPath ?? raw.path;
    paxPath = null;
    const destPath = resolveSafely(destDir, path);

    if (typeflag === "5") {
      await mkdir(destPath, { recursive: true, mode });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new Error(`unsupported tar entry type "${typeflag}" for "${path}" (only regular files and directories are supported)`);
    }

    const content = tar.subarray(offset, offset + size);
    offset += blockAligned(size);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content, { mode });
  }
}

/** Round `size` up to the next `BLOCK_SIZE` boundary — every tar entry occupies whole blocks. */
function blockAligned(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/**
 * Read `paths` from disk (relative to `rootDir`) plus any number of
 * in-memory `extraEntries`, and pack them all into one archive. Parent
 * directory entries are synthesized for every file so `unpackTarGz` never has
 * to `mkdir -p` past what the archive declares.
 */
export async function packFilesToTarGz(
  rootDir: string,
  paths: readonly string[],
  extraEntries: readonly TarEntry[] = [],
): Promise<Uint8Array> {
  const dirsSeen = new Set<string>();
  const entries: TarEntry[] = [];
  const addWithParents = (entry: TarEntry) => {
    for (const dir of parentDirs(entry.path)) {
      if (dirsSeen.has(dir)) continue;
      dirsSeen.add(dir);
      entries.push({ path: dir, mode: 0o755 });
    }
    entries.push(entry);
  };

  for (const relPath of paths) {
    const posixPath = relPath.split(sep).join("/");
    const absPath = join(rootDir, relPath);
    const st = await stat(absPath);
    addWithParents({
      path: posixPath,
      content: await readFile(absPath),
      mode: st.mode & 0o777,
    });
  }
  for (const entry of extraEntries) addWithParents(entry);

  return packTarGz(entries);
}

/** Recursively pack every file under `dir` into a gzip'd tar, paths relative to `dir`. */
export async function packDirToTarGz(dir: string): Promise<Uint8Array> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) files.push(relative(dir, abs));
    }
  }
  await walk(dir);
  return packFilesToTarGz(dir, files);
}

function parentDirs(posixPath: string): string[] {
  const parts = posixPath.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/") + "/");
  return out;
}

function buildUstarHeader(input: {
  /** Already split to fit `NAME_MAX`/`PREFIX_MAX` by the caller — see `splitPath`. */
  name: string;
  prefix: string;
  mode: number;
  size: number;
  typeflag: string;
}): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  writeStr(header, 0, NAME_MAX, input.name);
  writeOctal(header, 100, 8, input.mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, input.size);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(0x20, 148, 156); // checksum field: spaces while computing
  header[156] = input.typeflag.charCodeAt(0);
  writeStr(header, 257, 6, "ustar"); // magic (5 chars + \0)
  writeStr(header, 263, 2, "00"); // version
  writeStr(header, 345, PREFIX_MAX, input.prefix);

  // Unlike the other octal fields, the checksum is stored as "%06o\0 " (six
  // digits, NUL, space). Six digits always suffice: the maximum possible sum
  // (512 bytes of 0xff) is 0o377000.
  const checksum = header.reduce((sum, b) => sum + b, 0);
  writeStr(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");

  return header;
}

/**
 * ustar splits long paths into a <=155-byte prefix + <=100-byte name, joined
 * by '/'. Find the rightmost '/' such that everything after it still fits
 * in the 100-byte name field and everything before it fits in the 155-byte
 * prefix field — trying every slash from the right, since the split point
 * isn't simply "wherever the path first drops under 100 bytes from the end".
 *
 * `null` when no split works, which the caller answers with a pax extended
 * header. That is not a rare shape: one path component over 100 bytes — a
 * directory named after a non-ASCII test title — has no valid split at all.
 */
function splitPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path, "utf8") <= NAME_MAX) return { name: path, prefix: "" };

  const searchable = path.endsWith("/") ? path.slice(0, -1) : path;
  let slash = searchable.lastIndexOf("/");
  while (slash !== -1) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= PREFIX_MAX &&
      Buffer.byteLength(name, "utf8") <= NAME_MAX
    ) {
      return { name, prefix };
    }
    slash = searchable.lastIndexOf("/", slash - 1);
  }
  return null;
}

/**
 * The `path` value out of a pax extended header's records. Other keys (mtime,
 * uid, ...) are ignored — this packer only ever writes `path`, and a foreign
 * archive's extra metadata is not worth honouring in a report bundle.
 */
function parsePaxPath(records: Uint8Array): string | null {
  // "<len> <key>=<value>\n", repeated. The declared length is in BYTES and a
  // value may contain any byte, so walk the buffer rather than a decoded
  // string — a multi-byte path would desynchronise a character-indexed scan.
  const buf = Buffer.from(records);
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number.parseInt(buf.subarray(at, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0 || at + len > buf.length) break;
    const eq = buf.indexOf(0x3d /* = */, space + 1);
    if (eq !== -1 && eq < at + len && buf.subarray(space + 1, eq).toString("ascii") === "path") {
      // Drop the record's trailing newline; the value is everything before it.
      return buf.subarray(eq + 1, at + len - 1).toString("utf8");
    }
    at += len;
  }
  return null;
}

function parseHeader(header: Uint8Array): { path: string; size: number; mode: number; typeflag: string } {
  const name = readStr(header, 0, NAME_MAX);
  const prefix = readStr(header, 345, PREFIX_MAX);
  const mode = readOctal(header, 100, 8);
  const size = readOctal(header, 124, 12);
  const typeflag = String.fromCharCode(header[156] ?? 0);
  const path = prefix ? `${prefix}/${name}` : name;
  return { path, size, mode, typeflag };
}

function resolveSafely(destDir: string, entryPath: string): string {
  if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
    throw new Error(`refusing to unpack unsafe tar entry path: "${entryPath}"`);
  }
  return join(destDir, ...entryPath.split("/"));
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((b) => b === 0);
}

function padding(contentLength: number): Uint8Array {
  const rem = contentLength % BLOCK_SIZE;
  return rem === 0 ? new Uint8Array(0) : new Uint8Array(BLOCK_SIZE - rem);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function writeStr(buf: Uint8Array, offset: number, maxLen: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maxLen) {
    throw new Error(`value too long for ${maxLen}-byte tar header field: "${value}"`);
  }
  buf.set(bytes, offset);
}

function readStr(buf: Uint8Array, offset: number, maxLen: number): string {
  const slice = buf.subarray(offset, offset + maxLen);
  const nul = slice.indexOf(0);
  return Buffer.from(nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

function writeOctal(buf: Uint8Array, offset: number, fieldLen: number, value: number): void {
  // fieldLen includes the trailing NUL; ustar octal fields are zero-padded ASCII.
  const octal = value.toString(8);
  const str = octal.padStart(fieldLen - 1, "0");
  if (str.length > fieldLen - 1) {
    throw new Error(`value ${value} does not fit in ${fieldLen}-byte octal tar header field`);
  }
  writeStr(buf, offset, fieldLen, str);
}

function readOctal(buf: Uint8Array, offset: number, fieldLen: number): number {
  const str = readStr(buf, offset, fieldLen).trim();
  return str === "" ? 0 : parseInt(str, 8);
}
