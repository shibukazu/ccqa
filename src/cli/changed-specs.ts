import { getChangedFilesBetween } from "../drift/affected.ts";
import { RunUsageError } from "../run/errors.ts";
import { resolveAnalysisBase, type AnalysisBase } from "../run/git-context.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadCoverageEdges } from "../select/coverage-edges.ts";
import { loadSpecInventory } from "../select/inventory.ts";
import { specsToRun } from "../select/types.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import type { HubContext } from "./hub-conn.ts";
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
  /**
   * Where the coverage edges are read from. `null` (no hub configured) leaves
   * every spec the mechanical pass cannot settle `unknown` — those run, so a
   * missing hub costs runs, never a skipped regression.
   */
  hub: HubContext | null;
  /** Suppress progress lines. Set for machine-readable output, which shares stdout. */
  quiet?: boolean;
  /** How the calling command spells the flag, for error messages. */
  flagName?: string;
}

/**
 * Filter specs to those a range of commits reaches. Powers `ccqa run
 * --only-affected-by <ref>`; `ccqa audit` uses the same call.
 *
 * The decision is made by `ccqa select-specs`, which intersects the diff with
 * each spec's last measured reach from the hub (ADR-0024). Deterministic and
 * free — no model call — and wrong in only one direction: a spec without a
 * measurement comes back `unknown` and runs.
 *
 * Specs come back `needed`, `notNeeded` or `unknown`; everything but
 * `notNeeded` runs. `unknown` is the selector saying it has no measurement to
 * consult, and the safe reading of that is to run the spec.
 */
export async function collectChangedSpecs(
  specs: readonly SpecRef[],
  opts: CollectChangedOptions,
): Promise<ChangedSelection> {
  const { cwd, base, hub, quiet, flagName } = opts;
  const flag = flagName ?? "--only-affected-by";
  const resolved = await resolveAnalysisBase(base, flag, cwd);
  const meta = (key: string, value: string | number) => {
    if (!quiet) log.meta(key, value);
  };

  let changed;
  try {
    // Renames stay delete + add: the diff is intersected with reach measured
    // before the rename, and only the old path can match an edge.
    changed = await getChangedFilesBetween(resolved.sha, "HEAD", cwd, { detectRenames: false });
  } catch (e) {
    throw new RunUsageError(
      `failed to run 'git diff' against ${resolved.ref}: ${(e as Error).message}`,
    );
  }

  meta("changed-base", `${resolved.ref} (${resolved.sha.slice(0, 12)})`);
  meta("changed-files", changed.length);
  if (changed.length === 0) return { specs: [], base: resolved };

  // No hub reads as degraded (undecided specs stay `unknown`, which this
  // path runs) rather than as an unmeasured suite; the warning is this
  // command's, the semantics are loadCoverageEdges'.
  if (!hub) {
    log.warn(
      `${flag}: no hub connection, so coverage measurements cannot be consulted — undecided specs will run`,
    );
  }
  // Never rejects, so it can safely overlap the inventory walk below.
  const edgesPromise = loadCoverageEdges(hub);

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
    edges: await edgesPromise,
  });

  const toRun = new Set(specsToRun(report).map(specKey));
  const undecided = report.specs.filter((s) => s.verdict === "unknown").length;
  if (undecided > 0) {
    meta("changed-unknown", `${undecided} spec(s) could not be decided — running them`);
  }

  return { specs: specs.filter((s) => toRun.has(specKey(s))), base: resolved };
}
