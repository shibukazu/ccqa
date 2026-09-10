import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The code a generated test leans on, found by following its imports.
 *
 * A page object holds the selectors that actually run, so an audit that reads
 * only the test file clears strings it never saw. What the test imports is the
 * one description of that surface which cannot go stale: it is how the code
 * itself finds the file.
 *
 * Only imports that resolve inside the project are followed — a relative
 * specifier, or one matching a `paths` alias in the project's `tsconfig.json`.
 * Packages are not: their code is not the consumer's to fix, and descending
 * into `node_modules` would bury the audit in vendor sources.
 */

/** How many import hops out from the test file are followed. */
export const DEFAULT_IMPORT_DEPTH = 3;

/**
 * How many files the walk may collect. Depth alone does not bound it: one
 * barrel `index.ts` re-exporting a directory fans out to everything in it, and
 * the caller reads what the walk returns. Far more than an audit's budget can
 * hold, so the cap only stops the pathological case.
 */
const MAX_SUPPORT_FILES = 200;

/** Extensions tried when a specifier names no file, TypeScript sources first. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Module specifiers, in the forms generated tests use: `from "x"`, a
 * side-effect `import "x"`, `import("x")`, and `require("x")`. A string this
 * over-matches (prose after the word "from" in a comment) resolves to no file
 * and drops out.
 */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

export interface TsconfigPaths {
  /** Absolute directory `paths` patterns resolve against. */
  baseUrlAbs: string;
  /** `compilerOptions.paths`, verbatim. */
  paths: Record<string, string[]>;
}

/**
 * Read `<cwd>/tsconfig.json`'s `baseUrl` / `paths`, following a relative
 * `extends` chain — a workspace commonly keeps its aliases in a base config,
 * and stopping at the leaf would drop exactly the page objects an audit needs.
 * A config published as a package is not followed: its aliases would resolve
 * inside `node_modules`, which this walker never reads anyway. Absent,
 * unreadable, or aliasless: null, and only relative imports are followed.
 */
export async function loadTsconfigPaths(cwd: string): Promise<TsconfigPaths | null> {
  let configPath: string | null = join(cwd, "tsconfig.json");
  const seen = new Set<string>();
  while (configPath !== null && !seen.has(configPath)) {
    seen.add(configPath);
    const parsed = await readTsconfig(configPath);
    if (parsed === null) return null;
    const options = parsed.compilerOptions;
    if (options?.paths) {
      // `baseUrl` is relative to the config that declares the paths.
      return { baseUrlAbs: resolve(dirname(configPath), options.baseUrl ?? "."), paths: options.paths };
    }
    configPath =
      typeof parsed.extends === "string" && parsed.extends.startsWith(".")
        ? withJsonExtension(resolve(dirname(configPath), parsed.extends))
        : null;
  }
  return null;
}

interface RawTsconfig {
  extends?: string;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

async function readTsconfig(path: string): Promise<RawTsconfig | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(stripJsonComments(raw)) as RawTsconfig;
  } catch {
    return null;
  }
}

/** `extends` may name a config with the extension left off. */
function withJsonExtension(path: string): string {
  return path.endsWith(".json") ? path : `${path}.json`;
}

/** Strip line and block comments and trailing commas — tsconfig.json is JSONC. */
function stripJsonComments(text: string): string {
  const uncommented = text.replace(
    /"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match.startsWith('"') ? match : ""),
  );
  return uncommented.replace(/,(\s*[}\]])/g, "$1");
}

/** One file the walk reached, and the file whose import led to it. */
export interface SupportFile {
  abs: string;
  /** Absolute path of the importer — how this file came to be part of the case. */
  from: string;
}

/**
 * Files reachable from `entryAbs` by following project-internal imports, in
 * breadth-first order and excluding the entry itself. Reading a file that
 * cannot be read yields no imports rather than an error: a missing import
 * target is the audit's business, not this walker's.
 */
export async function collectSupportFiles(
  entryAbs: string,
  cwd: string,
  opts: { maxDepth?: number; tsconfig?: TsconfigPaths | null } = {},
): Promise<SupportFile[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_IMPORT_DEPTH;
  const tsconfig = opts.tsconfig !== undefined ? opts.tsconfig : await loadTsconfigPaths(cwd);
  const seen = new Set([entryAbs]);
  const found: SupportFile[] = [];
  let frontier = [entryAbs];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    // One level at a time, resolved together: the files in a level are
    // independent, but the order they are recorded in must stay the walk's,
    // not whichever `stat` answered first.
    const levels = await Promise.all(
      frontier.map(async (fileAbs) =>
        (await resolveImportsOf(fileAbs, cwd, tsconfig)).map((abs) => ({ abs, from: fileAbs })),
      ),
    );
    const next: string[] = [];
    for (const entry of levels.flat()) {
      if (seen.has(entry.abs)) continue;
      seen.add(entry.abs);
      found.push(entry);
      next.push(entry.abs);
      if (found.length >= MAX_SUPPORT_FILES) return found;
    }
    frontier = next;
  }
  return found;
}

/** Every project file one file imports, in source order. */
async function resolveImportsOf(
  fileAbs: string,
  cwd: string,
  tsconfig: TsconfigPaths | null,
): Promise<string[]> {
  const source = await readFile(fileAbs, "utf8").catch(() => null);
  if (source === null) return [];
  const specifiers = [...source.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]!);
  const resolved = await Promise.all(
    specifiers.map((s) => resolveSpecifier(s, dirname(fileAbs), cwd, tsconfig)),
  );
  return resolved.filter((p): p is string => p !== null);
}

/**
 * One specifier → an existing file inside the project, or null. Anything that
 * escapes the project root, or lands in `node_modules`, is dropped: it is not
 * the consumer's code to read.
 */
async function resolveSpecifier(
  specifier: string,
  fromDirAbs: string,
  cwd: string,
  tsconfig: TsconfigPaths | null,
): Promise<string | null> {
  const candidates = specifier.startsWith(".")
    ? [resolve(fromDirAbs, specifier)]
    : isAbsolute(specifier)
      ? []
      : aliasCandidates(specifier, tsconfig);
  for (const candidate of candidates) {
    const file = await resolveFile(candidate);
    if (file === null) continue;
    if (file.split(/[\\/]/).includes("node_modules")) return null;
    return file.startsWith(`${cwd}/`) ? file : null;
  }
  return null;
}

/** Every path a `paths` alias maps this specifier to, in config order. */
function aliasCandidates(specifier: string, tsconfig: TsconfigPaths | null): string[] {
  if (!tsconfig) return [];
  const out: string[] = [];
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) out.push(...targets.map((t) => resolve(tsconfig.baseUrlAbs, t)));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    out.push(
      ...targets.map((t) => resolve(tsconfig.baseUrlAbs, t.replace("*", matched))),
    );
  }
  return out;
}

/** A path → the file it names: itself, `<path><ext>`, or `<path>/index<ext>`. */
async function resolveFile(pathAbs: string): Promise<string | null> {
  if (await isFile(pathAbs)) return pathAbs;
  // `./page.js` under NodeNext names `./page.ts` — try the TypeScript source
  // before the extension list, which would otherwise never reach it.
  const rewritten = pathAbs.replace(/\.(js|mjs|cjs)$/, "");
  if (rewritten !== pathAbs) {
    for (const ext of EXTENSIONS) {
      if (await isFile(rewritten + ext)) return rewritten + ext;
    }
  }
  for (const ext of EXTENSIONS) {
    if (await isFile(pathAbs + ext)) return pathAbs + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexed = join(pathAbs, `index${ext}`);
    if (await isFile(indexed)) return indexed;
  }
  return null;
}

function isFile(pathAbs: string): Promise<boolean> {
  return stat(pathAbs).then(
    (s) => s.isFile(),
    () => false,
  );
}
