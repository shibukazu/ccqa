import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import type { RerunReport, RerunState } from "../hub/contract/schema.ts";
import { specKey, type SpecRef } from "../store/index.ts";
import { errMessage, RunUsageError } from "./errors.ts";
import { LAST_RUN } from "./git-context.ts";

/**
 * `ccqa run --changed=last-run`: select specs from the hub's re-run verdicts
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
 * The profile `--changed=last-run` asks about. Mandatory: two environments sit
 * at different commits and the deploy log is per-profile, so "needs re-run"
 * has no profile-free answer.
 */
export function requireRerunProfile(profile: string | undefined): string {
  if (profile === undefined) {
    throw new RunUsageError(
      `--changed=${LAST_RUN} requires --profile <name>: the deploy log it reads is per-profile, ` +
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
      `--changed=${LAST_RUN}: could not ask the hub which specs need a re-run: ${errMessage(err)}`,
    );
  }
  if (report.deployHead === null) {
    throw new RunUsageError(
      `--changed=${LAST_RUN}: no deploy has been recorded for profile "${profile}" of project ` +
        `"${hubCtx.project}", so nothing can be compared against. Wire \`ccqa hub deploy record\` ` +
        `into the deploy job, or pass an explicit baseline (--changed=<ref>).`,
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
      `--changed=${LAST_RUN}: project "${hubCtx.project}" has no perspectives document on the hub, ` +
      `so no spec is registered to compare against a deploy. Run \`ccqa perspectives\` first.`
    );
  }
  return (
    `--changed=${LAST_RUN}: this hub does not serve re-run verdicts — it needs ccqa ` +
    `${RERUN_MIN_HUB_VERSION} or newer. Upgrade the hub, or pass an explicit baseline (--changed=<ref>).`
  );
}

/** States the summary line reports, worst-known-first. */
const SUMMARY_ORDER: readonly RerunState[] = [
  "needed",
  "unknown",
  "neverRun",
  "notNeeded",
  "notEvaluated",
];

/** States that mean "the hub has no verdict", as opposed to a verdict of "no". */
const UNANSWERABLE = new Set<RerunState>(["unknown", "neverRun", "notEvaluated"]);

export interface RerunSelection {
  selected: SpecRef[];
  /** "3 needed, 1 unknown, 12 notNeeded" — every offered spec accounted for. */
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
 * `needed` is always selected. `unknown` and `neverRun` are "the question
 * cannot be answered", so they are excluded by default and opted into with
 * `--include-unknown` — fail-open on request, never silently. `notNeeded` and
 * `notEvaluated` are never selected.
 */
export function selectSpecsNeedingRerun(
  specs: readonly SpecRef[],
  report: RerunReport,
  opts: { includeUnknown: boolean },
): RerunSelection {
  const selectable = new Set<RerunState>(
    opts.includeUnknown ? ["needed", "unknown", "neverRun"] : ["needed"],
  );
  const counts = new Map<RerunState, number>();
  const selected: SpecRef[] = [];
  let excludedUnanswerable = 0;
  for (const spec of specs) {
    // A spec the perspectives document does not list has no verdict at all,
    // which is the same "cannot answer" as `unknown` — never "not needed".
    const state = report.specs[specKey(spec)]?.state ?? "unknown";
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (selectable.has(state)) selected.push(spec);
    else if (UNANSWERABLE.has(state)) excludedUnanswerable++;
  }
  const summary = SUMMARY_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  return { selected, summary, excludedUnanswerable };
}
