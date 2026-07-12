import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compileGlob } from "../drift/affected.ts";
import type { Conventions, ResourceRef } from "./types.ts";

/**
 * Resolution of the config's `resources` / `conventions` entries for the LLM
 * generation engine. Config keeps the entries verbatim (they may be glob
 * patterns); this module expands them:
 *
 *   - path resources     → an existing repo file/dir root the agent explores
 *                          (and under which generated support files may land);
 *   - package resources  → the installed package's directory (README, `.d.ts`,
 *                          exports), resolved from node_modules — read-only;
 *   - conventions        → guide/example file bodies injected into the prompt,
 *                          under a total size cap.
 *
 * An entry that resolves to nothing is an error, never a silent skip — a
 * typo'd resource would otherwise quietly produce reuse-free output.
 *
 * Glob support reuses `compileGlob` (the deliberately small `**` / `*` / `?`
 * language of relatedPaths) plus a readdir walk, so no glob dependency is
 * added and the `engines` floor (Node 20, no `fs.glob`) keeps working.
 */

export interface ResolvedResource {
  kind: "path" | "package";
  /** What generated code imports: the configured path/glob or package name. */
  ref: string;
  description?: string;
  /** Absolute file or directory the agent may explore. */
  rootAbs: string;
  /** Root as shown in the prompt: cwd-relative for repo paths, absolute for packages. */
  rootDisplay: string;
  /** True for path resources: generated support files may be written under the root. */
  writable: boolean;
}

/** Directories never descended into during glob expansion. */
const WALK_SKIP_DIRS = new Set(["node_modules", ".git"]);

const hasWildcard = (pattern: string): boolean => /[*?]/.test(pattern);

/**
 * The static directory prefix of a glob pattern — the segments before the
 * first one containing a wildcard (`e2e/pages/**\/*.ts` → `e2e/pages`).
 * Doubles as the walk root and as the write-allowed root for path resources.
 */
export function globBase(pattern: string): string {
  const segments = pattern.split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (hasWildcard(segment)) break;
    staticSegments.push(segment);
  }
  return staticSegments.join("/") || ".";
}

/** Recursively collect files under `dirAbs`, skipping node_modules/.git. */
async function walkFiles(dirAbs: string): Promise<string[]> {
  const entries = await readdir(dirAbs, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) out.push(...(await walkFiles(abs)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Expand one path-or-glob entry to the cwd-relative files it names, sorted.
 * A literal file yields itself; a literal directory yields every file under
 * it. Throws when nothing matches — see the module doc on silent skips.
 */
export async function expandPatternToFiles(cwd: string, pattern: string): Promise<string[]> {
  if (!hasWildcard(pattern)) {
    const abs = resolve(cwd, pattern);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new Error(`"${pattern}" does not exist (resolved to ${abs})`);
    const files = st.isDirectory() ? await walkFiles(abs) : [abs];
    return files.map((f) => relative(cwd, f)).sort();
  }
  const base = globBase(pattern);
  const baseAbs = resolve(cwd, base);
  const st = await stat(baseAbs).catch(() => null);
  if (!st?.isDirectory()) {
    throw new Error(`"${pattern}" matches nothing — its base directory ${base} does not exist`);
  }
  const matcher = compileGlob(pattern);
  const matched = (await walkFiles(baseAbs))
    .map((f) => relative(cwd, f))
    .filter((rel) => matcher.test(rel))
    .sort();
  if (matched.length === 0) throw new Error(`"${pattern}" matches no files under ${base}`);
  return matched;
}

/**
 * Resolve an installed package's directory from `cwd`'s node_modules chain.
 * Tries `require.resolve("<name>/package.json")` first; packages whose
 * `exports` hide package.json fall back to a manual node_modules walk-up.
 */
export async function resolvePackageRoot(cwd: string, name: string): Promise<string> {
  const req = createRequire(join(resolve(cwd), "noop.js"));
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    // fall through to the manual walk
  }
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    const isPkg = await stat(join(candidate, "package.json"))
      .then((s) => s.isFile())
      .catch(() => false);
    if (isPkg) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `resource package "${name}" could not be resolved from ${cwd} — is it installed?`,
  );
}

/**
 * Resolve every configured resource. Each failure names the offending entry
 * so a config typo is a hard, attributable error.
 */
export async function resolveResources(
  cwd: string,
  refs: ResourceRef[],
): Promise<ResolvedResource[]> {
  return Promise.all(
    refs.map(async (ref): Promise<ResolvedResource> => {
      if ("path" in ref) {
        // Existence (and non-empty match, for globs) is the whole check —
        // the file list itself isn't needed, the agent explores the root.
        if (hasWildcard(ref.path)) {
          await expandPatternToFiles(cwd, ref.path).catch((e) => {
            throw new Error(`resource path ${(e as Error).message}`);
          });
        } else {
          const exists = await stat(resolve(cwd, ref.path)).catch(() => null);
          if (!exists) {
            throw new Error(`resource path "${ref.path}" does not exist under ${cwd}`);
          }
        }
        const root = hasWildcard(ref.path) ? globBase(ref.path) : ref.path;
        return {
          kind: "path",
          ref: ref.path,
          description: ref.description,
          rootAbs: resolve(cwd, root),
          rootDisplay: root,
          writable: true,
        };
      }
      const rootAbs = await resolvePackageRoot(cwd, ref.package);
      return {
        kind: "package",
        ref: ref.package,
        description: ref.description,
        rootAbs,
        rootDisplay: rootAbs,
        writable: false,
      };
    }),
  );
}

/** Total byte budget for conventions bodies injected into the prompt. */
export const CONVENTIONS_MAX_BYTES = 64 * 1024;

export interface ConventionSection {
  path: string;
  body: string;
}

export interface LoadedConventions {
  sections: ConventionSection[];
  warnings: string[];
}

/**
 * Expand and read the conventions guides + examples, in declared order, into
 * prompt sections. Files are kept whole while they fit the byte budget; a
 * file that does not fit is dropped with a warning naming it (never a silent
 * truncation). Only when the very first file alone exceeds the budget is it
 * truncated instead — an empty conventions injection would be worse.
 */
export async function loadConventions(
  cwd: string,
  conventions: Conventions,
  maxBytes: number = CONVENTIONS_MAX_BYTES,
): Promise<LoadedConventions> {
  const files: string[] = [];
  for (const pattern of [...conventions.guides, ...conventions.examples]) {
    const matched = await expandPatternToFiles(cwd, pattern).catch((e) => {
      throw new Error(`conventions entry ${(e as Error).message}`);
    });
    for (const f of matched) {
      if (!files.includes(f)) files.push(f);
    }
  }

  const sections: ConventionSection[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const file of files) {
    const body = await readFile(resolve(cwd, file), "utf8");
    const size = Buffer.byteLength(body, "utf8");
    if (used + size <= maxBytes) {
      sections.push({ path: file, body });
      used += size;
    } else if (sections.length === 0) {
      const truncated = Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8");
      sections.push({ path: file, body: truncated });
      used = maxBytes;
      warnings.push(
        `conventions file ${file} exceeds the ${maxBytes}-byte prompt budget alone — injected truncated`,
      );
    } else {
      dropped.push(`${file} (${size} bytes)`);
    }
  }
  if (dropped.length > 0) {
    warnings.push(
      `conventions exceed the ${maxBytes}-byte prompt budget — dropped: ${dropped.join(", ")}`,
    );
  }
  return { sections, warnings };
}

/** True when `abs` is `rootAbs` itself or lives underneath it. */
export function isWithin(rootAbs: string, abs: string): boolean {
  return abs === rootAbs || abs.startsWith(rootAbs + sep);
}
