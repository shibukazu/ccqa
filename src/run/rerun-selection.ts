import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import { RerunReportSchema, type RerunReport, type SpecVerdict } from "../hub/contract/schema.ts";
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
      `${FLAG}: this hub's re-run answer is not in a shape this ccqa understands — it is likely ` +
        `older than this CLI. Upgrade the hub, or select with --only-affected-by <ref> instead.`,
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
  needsRepair: 0, rerunNeeded: 1, unanswerable: 2, inProgress: 3, verified: 4,
});

export interface RerunSelection {
  selected: SpecRef[];
  /** "3 rerunNeeded, 1 unanswerable, 12 verified" — every offered spec accounted for. */
  summary: string;
  /**
   * Specs left out because the hub has no answer *yet*, split by which kind.
   * Non-zero with an empty selection means "nothing to run" is really "nothing
   * I can vouch for", which the caller must say out loud rather than exit
   * quietly on.
   */
  excludedUnanswerable: number;
  /**
   * Specs the audit has not caught up with. Counted apart from
   * `excludedUnanswerable` because the fix differs — one waits for the audit,
   * the other opts in with a flag — but it is the same failure to exit 0 on.
   */
  excludedInProgress: number;
}

/**
 * Narrow `specs` to the ones the hub says are worth running.
 *
 * `rerunNeeded` is always selected, and a spec that has never run is part of
 * it — a spec with no result at all is as uncovered as one whose result a
 * deploy invalidated. `unanswerable` is "the question cannot be answered", so
 * it is excluded by default and opted into with
 * `--only-hub-rerun-needed-with-unknown` — fail-open on request, never
 * silently. `needsRepair`, `inProgress` and `verified` are never selected:
 * running them repairs nothing, races something already in flight, or repeats
 * work that is still current.
 */
export function selectSpecsNeedingRerun(
  specs: readonly SpecRef[],
  report: RerunReport,
  opts: { includeUnknown: boolean },
): RerunSelection {
  const counts = new Map<SpecVerdict, number>();
  const selected: SpecRef[] = [];
  let excludedUnanswerable = 0;
  let excludedInProgress = 0;
  for (const spec of specs) {
    // A spec the perspectives document does not list has no verdict at all,
    // which is the same "cannot answer" — never "verified".
    const verdict = report.specs[specKey(spec)]?.verdict ?? "unanswerable";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    if (verdict === "rerunNeeded" || (opts.includeUnknown && verdict === "unanswerable")) {
      selected.push(spec);
    } else if (verdict === "unanswerable") {
      excludedUnanswerable++;
    } else if (verdict === "inProgress") {
      excludedInProgress++;
    }
  }
  return {
    selected,
    summary: formatCounts(SUMMARY_ORDER, counts),
    excludedUnanswerable,
    excludedInProgress,
  };
}
