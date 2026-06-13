import { describe, expect, test } from "vitest";
import {
  FailureAnalysisSchema,
  LabelsExportSchema,
  RunReportDataSchema,
  type RunReportData,
} from "./schema.ts";

function sampleData(): RunReportData {
  return {
    schemaVersion: 1,
    createdAt: "2026-06-10T00:00:00.000Z",
    runId: "1234567",
    git: { head: "abc1234", base: "origin/main" },
    model: null,
    language: null,
    promptVersion: "1",
    results: [
      {
        feature: "tasks",
        spec: "create",
        status: "passed",
        testCounts: { total: 3, passed: 3, failed: 0 },
        durationMs: 1500,
        assertions: [{ name: "creates a task", status: "passed", durationMs: 1500 }],
        analysis: null,
        analysisSkipped: null,
        driftIssues: null,
        failureLogExcerpt: null,
        diffExcerpt: null,
        specYaml: null,
        evidence: null,
      },
      {
        feature: "tasks",
        spec: "complete",
        status: "failed",
        testCounts: { total: 3, passed: 2, failed: 1 },
        durationMs: null,
        assertions: null,
        analysis: {
          label: "TEST_DRIFT",
          confidence: 0.85,
          subDiagnosis: "SELECTOR_DRIFT",
          headline: "Submit button aria-label was renamed in the diff",
          evidence: [{ file: "src/app.tsx:42", detail: "aria-label renamed" }],
          recommendation: "Update the selector in the test to the new aria-label",
          reasoning: "selector renamed in the diff",
        },
        analysisSkipped: null,
        driftIssues: [
          {
            severity: "WARN",
            category: "assertable",
            stepId: "s1",
            message: "step asserts removed copy",
            detail: null,
          },
        ],
        failureLogExcerpt: "FAIL test > step",
        diffExcerpt: "diff --git a/x b/x",
        specYaml: "title: t",
        evidence: [
          {
            stepId: "step-01",
            source: "spec",
            pngPath: "evidence/tasks/complete/step-01.png",
            url: "http://app/dashboard",
            title: "Dashboard",
            capturedAt: "2026-06-10T00:00:01.000Z",
            description: "Redirected to /dashboard, user avatar visible in the header",
            status: "passed",
            failureSummary: null,
          },
        ],
      },
    ],
  };
}

describe("RunReportDataSchema", () => {
  test("round-trips a full report", () => {
    const data = sampleData();
    expect(RunReportDataSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });

  test("rejects an unknown predicted label", () => {
    const data = sampleData();
    (data.results[1]!.analysis as { label: string }).label = "FLAKY";
    expect(RunReportDataSchema.safeParse(data).success).toBe(false);
  });

  test("rejects a wrong schemaVersion", () => {
    const data = { ...sampleData(), schemaVersion: 2 };
    expect(RunReportDataSchema.safeParse(data).success).toBe(false);
  });
});

describe("FailureAnalysisSchema", () => {
  test("strips unknown keys instead of rejecting (LLM output is messy)", () => {
    const parsed = FailureAnalysisSchema.parse({
      label: "PRODUCT_BUG",
      confidence: 0.6,
      evidence: [],
      reasoning: "diff unrelated to the failing step",
      extraneous: "ignore me",
    });
    expect(parsed).not.toHaveProperty("extraneous");
    expect(parsed.label).toBe("PRODUCT_BUG");
  });

  test("rejects out-of-range confidence", () => {
    expect(
      FailureAnalysisSchema.safeParse({
        label: "UNKNOWN",
        confidence: 1.5,
        evidence: [],
        reasoning: "",
      }).success,
    ).toBe(false);
  });
});

describe("LabelsExportSchema", () => {
  test("accepts the export produced by the report's client JS", () => {
    const parsed = LabelsExportSchema.parse({
      schemaVersion: 1,
      runId: null,
      promptVersion: "1",
      exportedAt: "2026-06-10T00:00:00.000Z",
      labels: [
        {
          feature: "tasks",
          spec: "complete",
          predicted: "UNKNOWN",
          label: "PRODUCT_BUG",
          note: "real regression, fixed in #123",
        },
      ],
    });
    expect(parsed.labels).toHaveLength(1);
  });

  test("ground-truth label cannot be UNKNOWN", () => {
    expect(
      LabelsExportSchema.safeParse({
        schemaVersion: 1,
        runId: null,
        promptVersion: "1",
        exportedAt: "2026-06-10T00:00:00.000Z",
        labels: [{ feature: "f", spec: "s", predicted: "UNKNOWN", label: "UNKNOWN" }],
      }).success,
    ).toBe(false);
  });
});
