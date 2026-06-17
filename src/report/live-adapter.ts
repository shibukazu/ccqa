import { relative } from "node:path";
import { tryParseTestSpec } from "../spec/parser.ts";
import type { LiveRunResult } from "../runtime/live-executor.ts";
import type { LiveReportRun, LiveReportStep, ReportSpecResult } from "./schema.ts";

/**
 * Convert one live-mode (`mode: live`) execution result into the
 * persistence-layer `ReportSpecResult` shape consumed by `renderRunReport`.
 * The conversion does two non-trivial things:
 *
 *   - rewrites the executor's absolute `beforePng`/`afterPng` paths as
 *     `reportDir`-relative hrefs so the rendered HTML opens its PNGs
 *     directly when the report dir + the run dir are downloaded together
 *     as a CI artifact bundle
 *   - nulls out every vitest-only field so the report renderer falls
 *     through to its `liveRun` branch
 *
 * Lives in `src/report/` (not the CLI) because the relative-path contract
 * on `LiveReportStep.beforePng`/`afterPng` is a report-layer invariant,
 * documented next to the schema, and the CLI should not own it.
 */
export function liveRunToReportResult(args: {
  featureName: string;
  specName: string;
  specYaml: string;
  result: LiveRunResult;
  reportDir: string;
}): ReportSpecResult {
  const { featureName, specName, specYaml, result, reportDir } = args;
  const steps: LiveReportStep[] = result.steps.map((s) => ({
    stepId: s.stepId,
    source: s.source,
    instruction: s.instruction,
    expected: s.expected,
    status: s.status,
    reasoning: s.reasoning,
    beforePng: relativeIfPresent(s.beforePng, reportDir),
    afterPng: relativeIfPresent(s.afterPng, reportDir),
    durationMs: s.durationMs,
    cost: { ...s.cost },
  }));
  const liveRun: LiveReportRun = {
    runId: result.runId,
    sessionName: result.sessionName,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    steps,
    cost: { ...result.cost },
  };
  return {
    feature: featureName,
    spec: specName,
    title: tryParseTestSpec(specYaml)?.title ?? null,
    status: result.status,
    testCounts: null,
    durationMs: result.durationMs,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml,
    evidence: null,
    liveRun,
  };
}

function relativeIfPresent(absPath: string | null, reportDir: string): string | null {
  return absPath === null ? null : relative(reportDir, absPath);
}
