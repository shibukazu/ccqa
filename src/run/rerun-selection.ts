import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import type { RerunReport, SpecVerdict } from "../hub/contract/schema.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import { errMessage, RunUsageError } from "./errors.ts";

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

/** First ccqa release whose hub serves `GET /projects/:project/rerun`. */
const RERUN_MIN_HUB_VERSION = "1.9";

/** A report that carries a deploy head — the only shape a verdict can be trusted from. */
export type RerunBaseline = RerunReport & {
  deployHead: NonNullable<RerunReport["deployHead"]>;
};

/**
 * The profile `--only-hub-rerun-needed` asks about. Mandatory: two environments sit
 * at different commits and the deploy log is per-profile, so "needs re-run"
 * has no profile-free answer.
 */
export function requireRerunProfile(profile: string | undefined): string {
  if (profile === undefined) {
    throw new RunUsageError(
      `--only-hub-rerun-needed requires --hub-profile <name>: the deploy log it reads is per-profile, ` +
        `so which specs need a re-run has no answer without one`,
    );
  }
  return profile;
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
      throw new RunUsageError(explainNotFound(hubCtx, err));
    }
    throw new RunUsageError(
      `--only-hub-rerun-needed: could not ask the hub which specs need a re-run: ${errMessage(err)}`,
    );
  }
  if (report.deployHead === null) {
    throw new RunUsageError(
      `--only-hub-rerun-needed: no deploy has been recorded for profile "${profile}" of project ` +
        `"${hubCtx.project}", so nothing can be compared against. Wire \`ccqa hub deploy record\` ` +
        `into the deploy job, or select with --only-affected-by <ref> instead.`,
    );
  }
  return { ...report, deployHead: report.deployHead };
}

/**
 * Which of the two 404s this was. The handler answers `no_perspectives` when
 * the route exists but the project has no document; any other code on a 404
 * means the hub does not serve this route at all.
 */
function explainNotFound(hubCtx: HubContext, err: HubApiError): string {
  if (err.code === "no_perspectives") {
    return (
      `--only-hub-rerun-needed: project "${hubCtx.project}" has no perspectives document on the hub, ` +
      `so no spec is registered to compare against a deploy. Run \`ccqa perspectives\` first.`
    );
  }
  return (
    `--only-hub-rerun-needed: this hub does not serve re-run verdicts — it needs ccqa ` +
    `${RERUN_MIN_HUB_VERSION} or newer. Upgrade the hub, or select with --only-affected-by <ref> instead.`
  );
}

/** Verdicts the summary line reports, worst-known-first. */
const SUMMARY_ORDER: readonly SpecVerdict[] = [
  "needsRepair",
  "rerunNeeded",
  "unanswerable",
  "inProgress",
  "verified",
];

/** The one verdict that means "the hub has no answer", as opposed to an answer of "no". */
// `needsRepair` and `inProgress` are not in here: both are answers, and
// definite ones — the audit found something, or something is still running.
// Counting either as unanswerable would offer
// --only-hub-rerun-needed-with-unknown as the fix, and running a spec the
// audit rejected is exactly what that verdict exists to prevent.
const UNANSWERABLE = new Set<SpecVerdict>(["unanswerable"]);

export interface RerunSelection {
  selected: SpecRef[];
  /** "3 rerunNeeded, 1 unanswerable, 12 verified" — every offered spec accounted for. */
  summary: string;
  /**
   * Specs left out only because the hub could not answer for them. Non-zero
   * with an empty selection means "nothing to run" is really "nothing I can
   * vouch for", which the caller must say out loud rather than exit quietly on.
   */
  excludedUnanswerable: number;
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
  const selectable = new Set<SpecVerdict>(
    opts.includeUnknown ? ["rerunNeeded", "unanswerable"] : ["rerunNeeded"],
  );
  const counts = new Map<SpecVerdict, number>();
  const selected: SpecRef[] = [];
  let excludedUnanswerable = 0;
  for (const spec of specs) {
    // A spec the perspectives document does not list has no verdict at all,
    // which is the same "cannot answer" — never "verified".
    const verdict = report.specs[specKey(spec)]?.verdict ?? "unanswerable";
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    if (selectable.has(verdict)) selected.push(spec);
    else if (UNANSWERABLE.has(verdict)) excludedUnanswerable++;
  }
  const summary = SUMMARY_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return { selected, summary, excludedUnanswerable };
}
