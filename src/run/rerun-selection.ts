import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import {
  RerunReportSchema,
  type RerunReport,
  type RerunUnknownReason,
  type SpecVerdict,
} from "../hub/contract/schema.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import { errMessage, RunUsageError } from "./errors.ts";
import { explainHubNotFound, formatCounts, rankedOrder, requireHubProfile } from "./hub-selection.ts";

/**
 * `ccqa run --only-hub-rerun-needed`: select specs from the hub's re-run verdicts
 * instead of from a git diff (ADR-0010). The baseline is not a ref at all —
 * it is each spec's own last run, positioned against the deploy log the
 * consuming deploy job feeds the hub — so this path does no git work.
 *
 * Every "I cannot answer" is an error here, never an empty selection: an
 * unanswerable question that silently runs nothing is the one failure mode
 * that makes the whole feature dangerous.
 */

const FLAG = "--only-hub-rerun-needed";

/** A report that carries a deploy head — the only shape a verdict can be trusted from. */
export type RerunBaseline = RerunReport & {
  deployHead: NonNullable<RerunReport["deployHead"]>;
};

export function requireRerunProfile(profile: string | undefined): string {
  return requireHubProfile(FLAG, profile, "which specs need a re-run");
}

/**
 * Ask the hub which specs need a re-run, failing fast — before any spec runs —
 * on every condition that would otherwise degrade into "select nothing".
 */
export async function fetchRerunReport(
  hubCtx: HubContext,
  profile: string,
): Promise<RerunBaseline> {
  let report: RerunReport;
  try {
    report = await hubCtx.hub.getRerun(hubCtx.project, { profile });
  } catch (err) {
    if (err instanceof HubApiError && err.status === 404) {
      throw new RunUsageError(
        explainHubNotFound(FLAG, hubCtx.project, err, "which specs need a re-run"),
      );
    }
    throw new RunUsageError(
      `--only-hub-rerun-needed: could not ask the hub which specs need a re-run: ${errMessage(err)}`,
    );
  }
  // The wire shape changed with the two-axis verdict, and nothing else on this
  // path validates it: an older hub answers 200 with the previous field names,
  // every verdict reads `undefined`, and the run would exit 0 having selected
  // nothing. Parse before trusting.
  const parsed = RerunReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new RunUsageError(
      `${FLAG}: this hub's re-run answer is not in a shape this ccqa understands — the hub and ` +
        `this CLI are on different versions, and either side being newer can cause it (a newer ` +
        `hub may answer with verdicts this CLI does not know). Align the two, or select with ` +
        `--only-affected-by <ref> instead.`,
    );
  }
  report = parsed.data;
  if (report.deployHead === null) {
    throw new RunUsageError(
      `--only-hub-rerun-needed: no deploy has been recorded for profile "${profile}" of project ` +
        `"${hubCtx.project}", so nothing can be compared against. Wire \`ccqa hub deploy record\` ` +
        `into the deploy job, or select with --only-affected-by <ref> instead.`,
    );
  }
  return { ...report, deployHead: report.deployHead };
}

const SUMMARY_ORDER = rankedOrder<SpecVerdict>({
  needsRepair: 0, rerunNeeded: 1, inProgress: 2, manuallyVerified: 3, verified: 4,
});

export interface RerunSelection {
  /** Ordered least-recently-run first (never-run first); see `selectSpecsNeedingRerun`. */
  selected: SpecRef[];
  /** "3 rerunNeeded, 12 verified" — every offered spec accounted for. */
  summary: string;
  /**
   * Specs the audit has not caught up with. The one verdict that holds a spec
   * back without anyone having decided anything, so an empty selection with
   * this non-zero is "nothing I can vouch for", not "nothing to do" — the
   * caller must say so rather than exit quietly.
   */
  excludedInProgress: number;
  /**
   * Of `excludedInProgress`, how many the perspectives document has no entry
   * for at all — never audited, never run, unseen by the hub. `ccqa
   * perspectives` is what clears these, not another audit pass.
   */
  excludedUnknownToHub: number;
  /**
   * Of `excludedInProgress`, how many are `due` only because the deploy log
   * could not place the audit's own baseline (ADR-0014's "assumed reached").
   * Re-running the audit at the same commit reproduces the same hole, so
   * these need a different fix — named by `excludedAssumedReachedReasons`.
   */
  excludedAssumedReached: number;
  /** Deduped reasons behind `excludedAssumedReached`, in encounter order. */
  excludedAssumedReachedReasons: RerunUnknownReason[];
}

/**
 * Narrow `specs` to the ones the hub says are worth running.
 *
 * `rerunNeeded` is always selected, and it now covers everything the hub could
 * not place: a spec that never ran, and one whose currency the deploy log
 * cannot vouch for, are both as uncovered as one a deploy demonstrably
 * invalidated (ADR-0014). `needsRepair`, `inProgress` and `verified` are never
 * selected: running them repairs nothing, races something already in flight,
 * or repeats work that is still current. `manuallyVerified` is never selected
 * either — the test is still the broken one the attestation stands in for,
 * and running it would only relabel a person's answer with a machine failure.
 */
export function selectSpecsNeedingRerun(
  specs: readonly SpecRef[],
  report: RerunReport,
): RerunSelection {
  const counts = new Map<SpecVerdict, number>();
  const selected: Array<{ spec: SpecRef; lastRunAt: string }> = [];
  let excludedInProgress = 0;
  let excludedUnknownToHub = 0;
  let excludedAssumedReached = 0;
  const assumedReachedReasons = new Set<RerunUnknownReason>();
  for (const spec of specs) {
    const entry = report.specs[specKey(spec)];
    // A spec the perspectives document does not list has no verdict at all.
    // It has not been cleared either, so it is held back like any other
    // uncleared spec (ADR-0014) — never run uncleared, never "verified".
    const verdict = entry?.verdict ?? "inProgress";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    if (verdict === "rerunNeeded") {
      selected.push({ spec, lastRunAt: entry?.lastRun?.at ?? "" });
    } else if (verdict === "inProgress") {
      excludedInProgress++;
      if (!entry) {
        excludedUnknownToHub++;
      } else if (entry.auditAssumedReached) {
        excludedAssumedReached++;
        assumedReachedReasons.add(entry.auditAssumedReached);
      }
    }
  }
  // Least-recently-run first (never-run first; ISO timestamps compare
  // lexicographically, sort stability keeps catalog order on ties). This order
  // flows through to the printed plan, and pipelines that consume the plan cap
  // it at N specs — a fixed catalog order would starve the same trailing specs
  // every cycle after a mass invalidation. Wall-clock is fine here where it is
  // not for the staleness verdict (ADR-0010): every spec in `selected` already
  // needs a re-run, so a mis-ranking delays it, never excuses it.
  selected.sort((a, b) => a.lastRunAt.localeCompare(b.lastRunAt));
  return {
    selected: selected.map((s) => s.spec),
    summary: formatCounts(SUMMARY_ORDER, counts),
    excludedInProgress,
    excludedUnknownToHub,
    excludedAssumedReached,
    excludedAssumedReachedReasons: [...assumedReachedReasons],
  };
}
