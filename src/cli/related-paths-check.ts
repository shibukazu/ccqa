import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execFileP, matchesGlob } from "../drift/affected.ts";
import type { PerspectiveSpec } from "../types.ts";

/**
 * Data-quality check on `relatedPaths`: how many of a spec's patterns match no
 * file at all.
 *
 * A pattern that matches nothing is the failure mode that makes re-run
 * selection lie in the *dangerous* direction — too narrow a list produces a
 * confident "no re-run needed" for a spec whose code did change (ADR-0010).
 * It costs one file listing and no model call, so `ccqa perspectives` records
 * the count and the hub UI can warn next to the verdict.
 *
 * Patterns are interpreted relative to the directory hosting `.ccqa/`, the
 * same rule `--changed` applies. A pattern deliberately written repo-root
 * relative to reach a monorepo sibling package therefore counts as unmatched;
 * that is a false alarm, which is the harmless direction here.
 */

/** Directories the fallback walk never descends into: enormous, and never what `relatedPaths` target. */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * The files a `relatedPaths` pattern could possibly match, as cwd-relative
 * posix paths, listed once and shared by every spec.
 *
 * Tracked files, via `git ls-files`. That is not just the cheap way (a walk of
 * a large monorepo takes an order of magnitude longer and drags in `dist/`,
 * `.next/`, `coverage/`, past report directories) — it is the *correct*
 * universe: `relatedPaths` are only ever matched against `git diff` output,
 * both by `--changed` and by a deploy's `changedPaths`, and that output only
 * ever names tracked files. A pattern whose sole match is an untracked build
 * artifact can never match a real change, so counting it as matched would be a
 * miss in precisely the direction this check exists to catch.
 *
 * Falls back to a directory walk outside a git checkout, where the question
 * still has a useful approximate answer.
 */
export async function listCheckoutFiles(cwd: string): Promise<string[]> {
  try {
    // Paths come out relative to `cwd` (git's default without --full-name),
    // which is already the frame `relatedPaths` are written in. NUL-separated
    // so a path containing a newline can't split into two.
    const { stdout } = await execFileP("git", ["ls-files", "-z"], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    return walkFiles(cwd);
  }
}

/**
 * Every file under `cwd` as a cwd-relative posix path — the non-git fallback
 * for `listCheckoutFiles`. Symlinks are listed but not followed, so a link loop
 * cannot hang the walk. An unreadable directory is skipped rather than fatal:
 * the count is a warning signal, not a gate. Exported for tests, which cannot
 * otherwise reach this branch deterministically.
 */
export async function walkFiles(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [cwd];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else {
        out.push(relative(cwd, abs).split(sep).join("/"));
      }
    }
  }
  return out;
}

/** How many of `patterns` match none of `files`. */
export function countUnmatchedPatterns(
  patterns: readonly string[],
  files: readonly string[],
): number {
  return patterns.filter((pattern) => !files.some((file) => matchesGlob(file, pattern))).length;
}

/**
 * A perspective entry's `relatedPaths` fields — the list and its zero-match
 * count — produced together, so the two writers of the document (the full
 * `ccqa perspectives` build and the per-spec update after `ccqa record`) cannot
 * record one without the other. Empty for a spec that declares no paths: there
 * is nothing to check, which is not the same as "checked, all matched".
 */
export function relatedPathsFields(
  paths: readonly string[],
  files: readonly string[],
): Pick<PerspectiveSpec, "relatedPaths" | "relatedPathsUnmatched"> {
  if (paths.length === 0) return {};
  return { relatedPaths: [...paths], relatedPathsUnmatched: countUnmatchedPatterns(paths, files) };
}
