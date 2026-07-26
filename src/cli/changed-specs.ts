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
   * caller to resolve again: `ccqa drift` reports this to the hub, and a
   * second resolver would report a commit other than the one selection used.
   */
  base: AnalysisBase;
}

export interface CollectChangedOptions {
  cwd: string;
  base: string | true;
  model?: string;
  /** Suppress progress lines. Set for machine-readable output, which shares stdout. */
  quiet?: boolean;
  /** How this command spells "pass a base", for the no-base error. See `resolveAnalysisBase`. */
  baseExample?: string;
}

/**
 * Filter specs to those a range of commits reaches. Powers `ccqa run
 * --changed <ref>`; `ccqa drift --changed` uses the same call.
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
  const { cwd, base, model, quiet, baseExample } = opts;
  const resolved = await resolveAnalysisBase(base, "--changed", cwd, baseExample);
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
