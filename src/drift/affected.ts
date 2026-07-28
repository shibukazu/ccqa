import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  /**
   * Path relative to the ccqa working directory for files inside it;
   * repo-root relative for files outside it (see `outsideCwd`).
   */
  path: string;
  status: ChangeStatus;
  /**
   * True for a change outside the ccqa working directory (monorepo sibling
   * package). Kept with its repo-root-relative path: `ccqa select-specs`
   * treats these as product changes it cannot attribute to a local spec or
   * block, since a sibling package's own `.ccqa/` tree is not this one's.
   */
  outsideCwd?: boolean;
}

/**
 * GITHUB_BASE_REF holds a bare branch name (e.g. "main"); the local checkout
 * only has it as a remote-tracking ref, so prefix `origin/` unless already
 * qualified. Used by `ccqa run`'s resolveAnalysisBase (`src/run/git-context.ts`),
 * which both `ccqa run` and `ccqa audit` resolve their `--only-affected-by`
 * base through, so the rule can't drift between them.
 */
export function normalizeGithubBaseRef(ref: string): string {
  return ref.startsWith("origin/") ? ref : `origin/${ref}`;
}

/**
 * Paths that differ between `base` and `head` (two-dot: `git diff base..head`),
 * from `cwd`. Renames are reported under their NEW path with status
 * "renamed" — the OLD path is dropped since only the current layout matters.
 *
 * Two-dot vs three-dot (`base...head`) is a real choice, not a detail: for a
 * pull request, three-dot is right — changes that landed on the base branch
 * meanwhile are not this PR's doing. For "what changed in the environment
 * between these two deploys", three-dot is wrong — it hides a revert, because
 * a commit that was applied and then rolled back is absent from the
 * merge-base diff while the environment definitely moved (ADR-0010). Every
 * caller here answers the second question, so this is two-dot throughout.
 *
 * Paths are re-rooted to be relative to `cwd`, not the git repo root: in a
 * monorepo where `cwd` is a sub-package (e.g. `apps/foo`), git emits paths
 * relative to the repo root, but specs and blocks live under `cwd`'s own
 * `.ccqa/`. Changes outside `cwd` are kept under their repo-root path and
 * flagged `outsideCwd` (see `ChangedFile`) rather than dropped.
 *
 * `detectRenames` defaults on. `ccqa hub deploy record` turns it off (via
 * `changedPathsBetween`): with rename detection, a rename is one entry naming
 * only the destination, so a file's old path would silently drop out of the
 * report — off, it appears as a delete plus an add and both paths are kept.
 */
export async function getChangedFilesBetween(
  base: string,
  head: string,
  cwd: string,
  options: { detectRenames?: boolean } = {},
): Promise<ChangedFile[]> {
  return diffNameStatus(`${base}..${head}`, cwd, options.detectRenames ?? true);
}

async function diffNameStatus(range: string, cwd: string, detectRenames: boolean): Promise<ChangedFile[]> {
  const [{ stdout: rootOut }, { stdout: diffOut }] = await Promise.all([
    execFileP("git", ["rev-parse", "--show-toplevel"], { cwd }),
    execFileP("git", ["diff", "--name-status", detectRenames ? "-M" : "--no-renames", range], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    }),
  ]);
  return rerootChangedFiles(parseGitDiffOutput(diffOut), rootOut.trim(), cwd);
}

/**
 * Convert paths in `entries` from git-repo-root relative to `cwd` relative.
 * Entries outside `cwd` keep their repo-root path and are flagged
 * `outsideCwd`. Exported for unit tests.
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
    if (rel.startsWith("..") || rel === "") {
      out.push({ ...e, outsideCwd: true });
    } else {
      out.push({ ...e, path: rel });
    }
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

/** Normalize a leading `./` away so a diff path and a glob pattern compare. */
export function stripLeadingDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

const REGEX_CACHE = new Map<string, RegExp>();

/** Compiles `pattern` to a RegExp, memoized so repeated glob matches don't re-build. */
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
