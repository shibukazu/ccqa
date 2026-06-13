import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

/**
 * Resolve the base ref to diff against for `ccqa drift --changed`.
 * Precedence: explicit override > GITHUB_BASE_REF > origin/main.
 */
export function resolveBaseRef(explicit: string | undefined): string {
  if (explicit && explicit.length > 0) return explicit;
  const ghBase = process.env["GITHUB_BASE_REF"];
  if (ghBase && ghBase.length > 0) {
    return ghBase.startsWith("origin/") ? ghBase : `origin/${ghBase}`;
  }
  return "origin/main";
}

/**
 * Run `git diff --name-status base...HEAD` from `cwd` and return one entry per
 * changed file. Renames are reported under their NEW path with status
 * "renamed" — the OLD path is dropped because the spec mapping is against the
 * post-rename layout.
 *
 * Paths are re-rooted to be relative to `cwd`, not the git repo root. In a
 * monorepo where `cwd` is a sub-package (e.g. `apps/foo`), git emits paths
 * relative to the repo root, but specs declare relatedPaths relative to
 * their own package. Changes outside `cwd` are dropped so an unrelated PR
 * can never accidentally scope a sub-package's specs in.
 */
export async function getChangedFiles(base: string, cwd: string): Promise<ChangedFile[]> {
  const [{ stdout: rootOut }, { stdout: diffOut }] = await Promise.all([
    execFileP("git", ["rev-parse", "--show-toplevel"], { cwd }),
    execFileP("git", ["diff", "--name-status", "-M", `${base}...HEAD`], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    }),
  ]);
  return rerootChangedFiles(parseGitDiffOutput(diffOut), rootOut.trim(), cwd);
}

/**
 * Convert paths in `entries` from git-repo-root relative to `cwd` relative,
 * dropping anything outside `cwd`. Exported for unit tests.
 */
export function rerootChangedFiles(
  entries: ChangedFile[],
  repoRoot: string,
  cwd: string,
): ChangedFile[] {
  const prefix = relative(repoRoot, cwd);
  if (!prefix) return entries;
  const out: ChangedFile[] = [];
  for (const e of entries) {
    const rel = relative(prefix, e.path);
    if (rel.startsWith("..") || rel === "") continue;
    out.push({ ...e, path: rel });
  }
  return out;
}

export function parseGitDiffOutput(stdout: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (!code) continue;

    if (code.startsWith("R")) {
      // Rename: "R<score>\t<oldPath>\t<newPath>"
      const newPath = parts[2];
      if (newPath) out.push({ path: newPath, status: "renamed" });
      continue;
    }
    if (code.startsWith("C")) {
      // Copy: treat the new path as added
      const newPath = parts[2];
      if (newPath) out.push({ path: newPath, status: "added" });
      continue;
    }
    const path = parts[1];
    if (!path) continue;
    switch (code[0]) {
      case "A":
        out.push({ path, status: "added" });
        break;
      case "M":
      case "T":
        out.push({ path, status: "modified" });
        break;
      case "D":
        out.push({ path, status: "deleted" });
        break;
      default:
        // Unknown status — fall back to "modified" so we still consider it.
        out.push({ path, status: "modified" });
    }
  }
  return out;
}

/**
 * Returns true if `path` matches the glob `pattern`.
 *
 * Supports a deliberately small glob language sufficient for relatedPaths:
 *  - `**`  matches any number of path segments (including zero)
 *  - `*`   matches any run of characters that does NOT include `/`
 *  - `?`   matches exactly one character that is not `/`
 *  - leading `./` is stripped from both sides
 *
 * Everything else is treated literally. This is intentional — relatedPaths
 * comes from Claude and we want predictable matching behavior, not full
 * minimatch semantics.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  return compileGlob(pattern).test(stripLeadingDotSlash(path));
}

function stripLeadingDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

const REGEX_CACHE = new Map<string, RegExp>();

/** Compiles `pattern` to a RegExp, memoized so repeated `--changed` matches don't re-build. */
export function compileGlob(pattern: string): RegExp {
  const cached = REGEX_CACHE.get(pattern);
  if (cached) return cached;
  const compiled = globToRegExp(stripLeadingDotSlash(pattern));
  REGEX_CACHE.set(pattern, compiled);
  return compiled;
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (ch !== "*") {
      re += /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
      i++;
      continue;
    }
    if (pattern[i + 1] !== "*") {
      re += "[^/]*";
      i++;
      continue;
    }
    // `**`: match any number of segments (including zero). When flanked by
    // `/`, pull the surrounding slashes into an optional group so e.g.
    // `src/features/**` matches both `src/features` and `src/features/x/y`.
    const hasLeadingSlash = re.endsWith("/");
    const hasTrailingSlash = pattern[i + 2] === "/";
    if (hasLeadingSlash) re = re.slice(0, -1);
    if (hasLeadingSlash || hasTrailingSlash) re += "(?:/?.*)?";
    else re += ".*";
    i += hasTrailingSlash ? 3 : 2;
  }
  return new RegExp(re + "$");
}

/**
 * Returns true if `changedPath` is covered by any of `relatedPaths`. An empty
 * `relatedPaths` returns false — callers handle the "unscoped spec" case
 * separately (treat the spec as always-affected) before calling this.
 */
export function isPathAffectedBy(changedPath: string, relatedPaths: string[]): boolean {
  const stripped = stripLeadingDotSlash(changedPath);
  for (const pattern of relatedPaths) {
    if (compileGlob(pattern).test(stripped)) return true;
  }
  return false;
}
