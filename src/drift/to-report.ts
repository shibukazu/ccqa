import type { ReportSpecResult, RunReportData } from "../report/schema.ts";
import type { SpecResult, Threshold } from "./types.ts";

export const DRIFT_REPORT_PROMPT_VERSION = "1";

/**
 * Spec-level status under the given threshold, mirroring determineExitCode's
 * per-issue logic (exit-code.ts) but scoped to a single SpecResult.
 */
function specStatus(result: SpecResult, threshold: Threshold): "passed" | "failed" {
  if (result.error) return "failed";
  for (const issue of result.issues) {
    if (issue.severity === "ERROR") return "failed";
    if (threshold === "warn" && issue.severity === "WARN") return "failed";
  }
  return "passed";
}

/**
 * Adapts `ccqa drift` results into the shared RunReportData shape so they can
 * be pushed to the hub (`ccqa drift --push`) and rendered by the same report
 * UI as `ccqa run`/`ccqa live`. Browser-execution fields (testCounts,
 * evidence, liveRun, ...) don't apply to a drift audit and are always null.
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
    title: null,
    status: specStatus(result, meta.threshold),
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: result.issues,
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
