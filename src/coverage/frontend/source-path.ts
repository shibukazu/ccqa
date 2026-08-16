import { posix, relative, resolve, sep } from "node:path";

/**
 * Turns the source names a bundler writes into `sources` back into paths a
 * reader can find in the project.
 *
 * Bundlers namespace those entries — `webpack://_N_E/./src/a.ts`,
 * `webpack-internal:///(pages-dir-browser)/./src/a.ts` — and some write the
 * absolute path the build machine used. None of the forms is a project path on
 * its own.
 *
 * Anything that still resolves outside the root is dropped rather than
 * coerced. A framework's own runtime arrives as `../../../node_modules/...`,
 * and flattening those leading segments would invent a path that exists
 * nowhere and report the framework as project code nobody has a test for.
 *
 * Why a reason and not just `undefined`: dependency code is dropped on purpose
 * and a name nobody could resolve is a hole in the measurement. Reported as one
 * number the two are indistinguishable, and since dependencies dominate it by
 * orders of magnitude, the number reads as noise — which is how a real hole
 * goes unnoticed inside it.
 */

/** Dependency code is dropped: an unreached library file is not a missing test. */
const VENDOR = /(^|\/)node_modules\//;

/** `(rsc)`, `(pages-dir-browser)`, ... — which build layer, not part of the path. */
const LAYER = /^\([^)]*\)\//;

/**
 * The two directories a source name is read against.
 *
 * They differ when the project under test is one package of a workspace: the
 * bundler names a sibling package relative to the directory it ran in
 * (`../../packages/x/dist/index.mjs`), while the answer has to be rooted
 * somewhere that contains both.
 */
export interface SourceRoots {
  /** Absolute directory a relative source name is resolved against — where the build ran. */
  base: string;
  /** Absolute directory reported paths are relative to. Equal to `base` unless a workspace is in play. */
  root: string;
}

export type SourcePath =
  | { kind: "project"; path: string }
  /** Excluded on purpose. Not a gap, and counted apart from one. */
  | { kind: "dependency" }
  /** Named something this could not place. A file the result cannot mention. */
  | { kind: "unresolved" };

const DEPENDENCY: SourcePath = { kind: "dependency" };
const UNRESOLVED: SourcePath = { kind: "unresolved" };

/** `absolute` as a posix path under `root`, or undefined when it is not under it. */
export function toProjectRelative(root: string, absolute: string): string | undefined {
  const rel = relative(root, absolute).split(sep).join("/");
  return rel === "" || rel.startsWith("..") ? undefined : rel;
}

export function normalizeSourcePath(raw: string, roots: SourceRoots): SourcePath {
  if (VENDOR.test(raw)) return DEPENDENCY;

  let path = raw;
  const scheme = path.indexOf("://");
  if (scheme >= 0) {
    const afterScheme = path.slice(scheme + 3);
    const slash = afterScheme.indexOf("/");
    // A bundler scheme namespaces its first segment (`webpack://_N_E/`,
    // `webpack-internal:///(rsc)/`) and that segment is dropped. `file:` does
    // not: what follows the authority is a real absolute path, and dropping
    // its leading slash would make it relative and re-anchor it on `base`.
    const from = path.startsWith("file:") ? slash : slash + 1;
    path = slash < 0 ? afterScheme : afterScheme.slice(from);
  }
  path = posix.normalize(path.replace(LAYER, ""));
  if (path === "" || path === ".") return UNRESOLVED;
  // Anonymous and generated entries carry no file to point a reader at.
  if (path.startsWith("<") || path.startsWith("[")) return UNRESOLVED;

  // An absolute entry is the build machine's own path — common from bundlers
  // that do not rewrite `sources`. A relative one is relative to where the
  // build ran, which is why it is resolved against `base` and not `root`.
  const absolute = path.startsWith("/") ? path : resolve(roots.base, path);
  const rel = toProjectRelative(roots.root, absolute);
  if (rel === undefined) return UNRESOLVED;
  return VENDOR.test(rel) ? DEPENDENCY : { kind: "project", path: rel };
}
