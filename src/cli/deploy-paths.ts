import { execFileP, parseGitDiffOutput, rerootChangedFiles } from "../drift/affected.ts";

/**
 * What `ccqa hub deploy record` reports as a deploy's changed paths.
 *
 * The hub has no checkout, so this is the one thing only the deploy job can
 * answer (ADR-0010). Everything here exists to keep that answer honest in the
 * direction that matters: over-reporting makes a spec re-run once too often,
 * under-reporting makes it silently skip a real regression.
 */

/**
 * How many paths one deploy sends. A monorepo-wide refactor can list tens of
 * thousands, and the hub bounds the request body, so the list is cut here.
 *
 * The cap is deliberately far above the hub's own retention bound: whenever it
 * bites, the hub still receives more paths than it retains and marks the entry
 * `truncated`, which reads as "touched everything". A cap at or below the
 * hub's would instead present a cut-down list as a complete one — a confident
 * "no re-run needed" built on paths that were never sent.
 */
export const MAX_SENT_CHANGED_PATHS = 5000;

/** Cut `paths` to `MAX_SENT_CHANGED_PATHS`; see the constant for why the bound is where it is. */
export function capDeployPaths(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_SENT_CHANGED_PATHS);
}

/**
 * The files that differ between two commits, as a deploy must report them.
 *
 * **Two-dot** (`git diff A B`), never three-dot: three-dot resolves the merge
 * base first, so redeploying an ancestor — a rollback — reports an empty diff
 * and the rollback becomes invisible. `getChangedFiles` in
 * `src/drift/affected.ts` is three-dot, which is right for the PR question it
 * answers and wrong for this one.
 *
 * `--no-renames` is likewise deliberate: with rename detection a rename is one
 * entry naming only the destination, so a file moved *out* of a spec's
 * `relatedPaths` would no longer match it. Off, the rename appears as a delete
 * plus an add and both paths are reported.
 *
 * Paths are re-rooted to `cwd` on the same rule as `--changed`, because
 * `relatedPaths` are written as the directory hosting `.ccqa/` sees them.
 */
export async function changedPathsBetween(
  previous: string,
  sha: string,
  cwd: string,
): Promise<string[]> {
  const [{ stdout: rootOut }, { stdout: diffOut }] = await Promise.all([
    execFileP("git", ["rev-parse", "--show-toplevel"], { cwd }),
    execFileP("git", ["diff", "--name-status", "--no-renames", previous, sha], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    }),
  ]);
  // Parsed and re-rooted with the same helpers `--changed` uses, so the
  // monorepo path rule cannot drift between the two sides of the match.
  const entries = rerootChangedFiles(parseGitDiffOutput(diffOut), rootOut.trim(), cwd);
  return entries.map((f) => f.path);
}
