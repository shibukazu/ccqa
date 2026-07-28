import { getChangedFilesBetween } from "../drift/affected.ts";

/**
 * What `ccqa hub deploy record` reports as a deploy's changed paths.
 *
 * The hub has no checkout, so this is the one thing only the deploy job can
 * answer (ADR-0010). Record-only: the hub shows these paths, but re-run
 * verdicts are decided from `hasSelection` and the folded touch index, not
 * from `changedPaths` — see `DeployEntrySchema` in `hub/contract/schema.ts`.
 */

/**
 * How many paths one deploy sends. A monorepo-wide refactor can list tens of
 * thousands, and the hub bounds the request body, so the list is cut here —
 * comfortably above the hub's own retention bound (`MAX_RETAINED_CHANGED_PATHS`),
 * since there's no correctness reason to align the two once `changedPaths` is
 * display-only.
 */
export const MAX_SENT_CHANGED_PATHS = 5000;

/** Cut `paths` to `MAX_SENT_CHANGED_PATHS`; see the constant for why the bound is where it is. */
export function capDeployPaths(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_SENT_CHANGED_PATHS);
}

/**
 * The files that differ between two commits, as a deploy must report them.
 *
 * A thin wrapper over `getChangedFilesBetween` (two-dot, the same helper
 * `--only-affected-by` uses) with rename detection off — see that function's doc for
 * why two-dot is right here, and why this call turns renames off.
 */
export async function changedPathsBetween(
  previous: string,
  sha: string,
  cwd: string,
): Promise<string[]> {
  const entries = await getChangedFilesBetween(previous, sha, cwd, { detectRenames: false });
  return entries.map((f) => f.path);
}
