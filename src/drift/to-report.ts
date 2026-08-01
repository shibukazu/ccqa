import type { ReportSpecResult, RunReportData } from "../report/schema.ts";
import { currentReportCost } from "../report/run-cost.ts";
import { DRIFT_PROMPT_VERSION } from "../prompts/drift.ts";
import { driftSeverity, type SpecResult, type Threshold } from "./types.ts";

/** Tracks the drift prompt's own version — the two must never drift apart. */
export const DRIFT_REPORT_PROMPT_VERSION = DRIFT_PROMPT_VERSION;

/**
 * Spec-level status under the given threshold, mirroring determineExitCode's
 * per-spec logic (exit-code.ts) but scoped to a single SpecResult.
 */
function specStatus(result: SpecResult, threshold: Threshold): "passed" | "failed" {
  if (result.error) return "failed";
  if (!result.drift) return "passed";
  const severity = driftSeverity(result.drift.label);
  if (severity === "error") return "failed";
  if (threshold === "warn" && severity === "warn") return "failed";
  return "passed";
}

/**
 * Adapts `ccqa audit` results into the shared RunReportData shape so they can
 * be pushed to the hub (`ccqa audit --report-to-hub`) and rendered by the same report
 * UI as `ccqa run`/`ccqa live`. Browser-execution fields (testCounts,
 * evidence, liveRun, ...) don't apply to a drift audit and are always null —
 * which is why `mode` is carried separately: nothing ran, but which surfaces
 * were audited is still a fact about the row.
 *
 * Each result's diagnosis goes into `analysis`: for a `kind: "drift"` report
 * the diagnosis IS the row's verdict, so it renders through the same diagnosis
 * card a failed `ccqa run` spec does. `reasoning` has no drift-audit
 * equivalent (the audit gives one headline, not a deliberation) so it is
 * filled with an empty string to satisfy `FailureAnalysisSchema`.
 */
/**
 * One audited spec as a report row. Split out of `driftResultsToReport` so the
 * incremental push can send a row the moment its spec lands, using the same
 * mapping the final report uses — the hub upserts by feature/spec, so the two
 * must produce identical rows or the closing patch would rewrite history.
 */
export function driftResultToRow(result: SpecResult, threshold: Threshold): ReportSpecResult {
  return {
    feature: result.target.featureName,
    spec: result.target.specName,
    title: result.title ?? null,
    ...(result.live === undefined ? {} : { mode: result.live ? ("live" as const) : ("deterministic" as const) }),
    status: specStatus(result, threshold),
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: result.drift ? result.drift : null,
    analysisSkipped: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
  };
}

export function driftResultsToReport(
  results: SpecResult[],
  meta: {
    threshold: Threshold;
    git: { head: string | null; base: string | null };
    createdAt?: string;
    runId?: string | null;
    model?: string | null;
    language?: string | null;
    promptVersion?: string;
    /** `audit.agent` version applied to this sweep, or null when none was active. */
    customPromptVersion?: string | null;
    /** Content hash of the `audit.user` guidance applied to this sweep, or null when none was active. */
    triageUserPromptHash?: string | null;
  },
): RunReportData {
  const specResults = results.map((result) => driftResultToRow(result, meta.threshold));

  return {
    schemaVersion: 1,
    kind: "drift",
    createdAt: meta.createdAt ?? new Date().toISOString(),
    runId: meta.runId ?? null,
    git: meta.git,
    model: meta.model ?? null,
    language: meta.language ?? null,
    promptVersion: meta.promptVersion ?? DRIFT_REPORT_PROMPT_VERSION,
    customPromptVersion: meta.customPromptVersion ?? null,
    // Omitted (not null) when inactive — same convention `ccqa run` uses
    // (src/run/pipeline.ts's buildReportEnvelope) so report.json keeps its
    // historical shape when no `audit.user` guidance was active.
    ...(meta.triageUserPromptHash ? { triageUserPromptHash: meta.triageUserPromptHash } : {}),
    // What the sweep spent reading the specs. Read from the command's tally
    // rather than passed in: every caller is inside `ccqa audit`'s scope.
    cost: currentReportCost(),
    results: specResults,
  };
}
