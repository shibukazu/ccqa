import type { ReportSpecResult, RunReportData } from "../report/schema.ts";
import { emptySpecRow } from "../report/spec-row.ts";
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
 * One audited spec as a report row. Browser-execution fields don't apply to an
 * audit and stay empty — which is why `mode` is carried separately: nothing
 * ran, but which surfaces were audited is still a fact about the row. The
 * diagnosis goes into `analysis` because for a `kind: "drift"` report the
 * diagnosis IS the row's verdict, so it renders through the same card a failed
 * `ccqa run` spec does.
 *
 * Shared by the incremental push and the final report: the hub upserts by
 * feature/spec, so two mappings would let the closing patch rewrite history.
 */
export function driftResultToRow(result: SpecResult, threshold: Threshold): ReportSpecResult {
  return {
    ...emptySpecRow({
      feature: result.target.featureName,
      spec: result.target.specName,
      title: result.title ?? null,
      status: specStatus(result, threshold),
    }),
    ...(result.live === undefined ? {} : { mode: result.live ? ("live" as const) : ("deterministic" as const) }),
    analysis: result.drift,
  };
}

/**
 * Adapts `ccqa audit` results into the shared RunReportData shape so they can
 * be pushed to the hub (`ccqa audit --report-to-hub`) and rendered by the same
 * report UI as `ccqa run`/`ccqa live`.
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
