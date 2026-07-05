import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Minimal ustar (POSIX tar) reader/writer, purpose-built for shipping a
 * report directory between `ccqa hub push` and the hub (and back out on
 * download). No external tar dependency: the only thing this ever unpacks is
 * a tarball this same module packed, so the format only needs to cover what a
 * report dir actually contains — regular files and directories. Symlinks,
 * hardlinks, devices, and paths that don't fit ustar's 100+155 byte name
 * split are rejected outright rather than silently mishandled.
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
  for (const entry of entries) {
    blocks.push(buildHeader(entry));
    if (entry.content) {
      blocks.push(entry.content);
      blocks.push(padding(entry.content.length));
    }
  }
  // Two 512-byte zero blocks mark the end of the archive.
  blocks.push(new Uint8Array(BLOCK_SIZE * 2));
  return gzipSync(concat(blocks));
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
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) break; // end-of-archive marker
    offset += BLOCK_SIZE;

    const { path, size, mode, typeflag } = parseHeader(header);
    const destPath = resolveSafely(destDir, path);

    if (typeflag === "5") {
      await mkdir(destPath, { recursive: true, mode });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new Error(`unsupported tar entry type "${typeflag}" for "${path}" (only regular files and directories are supported)`);
    }

    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, content, { mode });
  }
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

function buildHeader(entry: TarEntry): Uint8Array {
  const isDir = entry.content === undefined;
  const path = isDir && !entry.path.endsWith("/") ? entry.path + "/" : entry.path;
  const { name, prefix } = splitPath(path);

  const header = new Uint8Array(BLOCK_SIZE);
  writeStr(header, 0, NAME_MAX, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, entry.content?.length ?? 0);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(0x20, 148, 156); // checksum field: spaces while computing
  header[156] = isDir ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeStr(header, 257, 6, "ustar"); // magic (5 chars + \0)
  writeStr(header, 263, 2, "00"); // version
  writeStr(header, 345, PREFIX_MAX, prefix);

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
 */
function splitPath(path: string): { name: string; prefix: string } {
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
  throw new Error(`path too long for ustar format (max ${NAME_MAX}+${PREFIX_MAX} bytes): "${path}"`);
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
