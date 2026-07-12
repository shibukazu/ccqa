import type { ReportSpecResult } from "./schema.ts";

/**
 * A report row with every optional section empty — the shape a spec gets when
 * it produced no vitest/live/evidence data (external-target runs, skipped
 * specs, target-resolution failures). Callers spread the fields they do have
 * on top.
 */
export function emptySpecRow(args: {
  feature: string;
  spec: string;
  title: string | null;
  status: ReportSpecResult["status"];
}): ReportSpecResult {
  return {
    feature: args.feature,
    spec: args.spec,
    title: args.title,
    status: args.status,
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
  };
}
