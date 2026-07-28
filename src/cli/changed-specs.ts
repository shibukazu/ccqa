import { getChangedFilesBetween } from "../drift/affected.ts";
import { RunUsageError } from "../run/errors.ts";
import { resolveAnalysisBase, type AnalysisBase } from "../run/git-context.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadSpecInventory } from "../select/inventory.ts";
import { specsToRun } from "../select/types.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import * as log from "./logger.ts";

export interface ChangedSelection {
  specs: SpecRef[];
  /**
   * The baseline actually diffed against. Returned rather than left for the
   * caller to resolve again: `ccqa audit` reports this to the hub, and a
   * second resolver would report a commit other than the one selection used.
   */
  base: AnalysisBase;
}

export interface CollectChangedOptions {
  cwd: string;
  base: string;
  model?: string;
  /** Suppress progress lines. Set for machine-readable output, which shares stdout. */
  quiet?: boolean;
  /** How the calling command spells the flag, for error messages. */
  flagName?: string;
}

/**
 * Filter specs to those a range of commits reaches. Powers `ccqa run
 * --only-affected-by <ref>`; `ccqa audit` uses the same call.
 *
 * The decision is made by `ccqa select-specs`, which reads the diff against
 * what each spec actually does. That costs one model call, against saving the
 * runs it excludes — the specs it clears are the expensive part.
 *
 * Specs come back `needed`, `notNeeded` or `unknown`; everything but
 * `notNeeded` runs. `unknown` is the selector saying it could not tell, and
 * the safe reading of that is to run the spec.
 */
export async function collectChangedSpecs(
  specs: readonly SpecRef[],
  opts: CollectChangedOptions,
): Promise<ChangedSelection> {
  const { cwd, base, model, quiet, flagName } = opts;
  const resolved = await resolveAnalysisBase(base, flagName ?? "--only-affected-by", cwd);
  const meta = (key: string, value: string | number) => {
    if (!quiet) log.meta(key, value);
  };

  let changed;
  try {
    changed = await getChangedFilesBetween(resolved.sha, "HEAD", cwd);
  } catch (e) {
    throw new RunUsageError(
      `failed to run 'git diff' against ${resolved.ref}: ${(e as Error).message}`,
    );
  }

  meta("changed-base", `${resolved.ref} (${resolved.sha.slice(0, 12)})`);
  meta("changed-files", changed.length);
  if (changed.length === 0) return { specs: [], base: resolved };

  let inventory;
  try {
    inventory = await loadSpecInventory(cwd);
  } catch (e) {
    // Selecting against a tree that will not parse would clear specs nobody
    // read. Surface it as a usage error rather than running a reduced set.
    throw new RunUsageError((e as Error).message);
  }

  const report = await selectSpecs({
    changed,
    specs: inventory,
    cwd,
    base: resolved.sha,
    head: "HEAD",
    ...(model ? { model } : {}),
  });

  const toRun = new Set(specsToRun(report).map(specKey));
  const undecided = report.specs.filter((s) => s.verdict === "unknown").length;
  if (undecided > 0) {
    meta("changed-unknown", `${undecided} spec(s) could not be decided — running them`);
  }

  return { specs: specs.filter((s) => toRun.has(specKey(s))), base: resolved };
}
