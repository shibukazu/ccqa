import type { ReportSpecResult, RunReportData } from "../report/schema.ts";
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
 * Adapts `ccqa drift` results into the shared RunReportData shape so they can
 * be pushed to the hub (`ccqa audit --report-to-hub`) and rendered by the same report
 * UI as `ccqa run`/`ccqa live`. Browser-execution fields (testCounts,
 * evidence, liveRun, ...) don't apply to a drift audit and are always null —
 * which is why `mode` is carried separately: nothing ran, but which surfaces
 * were audited is still a fact about the row.
 *
 * Each result's diagnosis goes into `analysis` (not `driftAudit`, which is a
 * normal run's OWN audit evidence) — for a `kind: "drift"` report the
 * diagnosis IS the row's verdict, so it renders through the same diagnosis
 * card a failed `ccqa run` spec does. `reasoning` has no drift-audit
 * equivalent (the audit gives one headline, not a deliberation) so it is
 * filled with an empty string to satisfy `FailureAnalysisSchema`.
 */
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
  },
): RunReportData {
  const specResults: ReportSpecResult[] = results.map((result) => ({
    feature: result.target.featureName,
    spec: result.target.specName,
    title: result.title ?? null,
    ...(result.live === undefined ? {} : { mode: result.live ? ("live" as const) : ("deterministic" as const) }),
    status: specStatus(result, meta.threshold),
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: result.drift ? result.drift : null,
    analysisSkipped: null,
    driftAudit: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
  }));

  return {
    schemaVersion: 1,
    kind: "drift",
    createdAt: meta.createdAt ?? new Date().toISOString(),
    runId: meta.runId ?? null,
    git: meta.git,
    model: meta.model ?? null,
    language: meta.language ?? null,
    promptVersion: meta.promptVersion ?? DRIFT_REPORT_PROMPT_VERSION,
    customPromptVersion: null,
    results: specResults,
  };
}
