import { describe, expect, test } from "vitest";
import { renderRunReport } from "./render.ts";
import type { ReportSpecResult, RunReportData } from "./schema.ts";

function passedResult(spec: string): ReportSpecResult {
  return {
    feature: "tasks",
    spec,
    status: "passed",
    testCounts: { total: 2, passed: 2, failed: 0 },
    durationMs: 1234,
    assertions: [
      { name: "step one", status: "passed", durationMs: 600 },
      { name: "step two", status: "passed", durationMs: 634 },
    ],
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
  };
}

function failedResult(spec: string, overrides: Partial<ReportSpecResult> = {}): ReportSpecResult {
  return {
    feature: "tasks",
    spec,
    status: "failed",
    testCounts: { total: 2, passed: 1, failed: 1 },
    durationMs: 4321,
    assertions: [
      { name: "step one", status: "passed", durationMs: 700 },
      { name: "step two", status: "failed", durationMs: 3621 },
    ],
    analysis: {
      label: "TEST_DRIFT",
      confidence: 0.85,
      subDiagnosis: "SELECTOR_DRIFT",
      evidence: [{ file: "src/app.tsx:42", detail: "aria-label renamed" }],
      reasoning: "selector renamed in the diff",
    },
    analysisSkipped: null,
    driftIssues: [
      {
        severity: "ERROR",
        category: "assertable",
        stepId: "s2",
        message: "asserted copy no longer exists",
        detail: null,
      },
    ],
    failureLogExcerpt: "FAIL  step 2\nexpected visible",
    diffExcerpt: "diff --git a/src/app.tsx b/src/app.tsx",
    specYaml: "title: complete a task",
    ...overrides,
  };
}

function report(results: ReportSpecResult[]): RunReportData {
  return {
    schemaVersion: 1,
    createdAt: "2026-06-10T12:00:00.000Z",
    runId: "987",
    git: { head: "abc1234", base: "origin/main" },
    model: null,
    promptVersion: "1",
    results,
  };
}

describe("renderRunReport", () => {
  test("includes every spec with its status", () => {
    const html = renderRunReport(report([passedResult("create"), failedResult("complete")]));
    expect(html).toContain("tasks/create");
    expect(html).toContain("tasks/complete");
    expect(html).toContain("1 passed");
    expect(html).toContain("1 failed");
  });

  test("renders prediction, evidence, drift audit, and ground-truth radios for a failure", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    expect(html).toContain("TEST_DRIFT");
    expect(html).toContain("85%");
    expect(html).toContain("SELECTOR_DRIFT");
    expect(html).toContain("aria-label renamed");
    expect(html).toContain("asserted copy no longer exists");
    for (const label of ["TEST_DRIFT", "SPEC_CHANGE", "PRODUCT_BUG"]) {
      expect(html).toContain(`value="${label}"`);
    }
    expect(html).toContain('id="metrics"');
    expect(html).toContain('id="export-labels"');
  });

  test("escapes HTML in model output and logs", () => {
    const html = renderRunReport(
      report([
        failedResult("complete", {
          analysis: {
            label: "PRODUCT_BUG",
            confidence: 0.5,
            subDiagnosis: "NONE",
            evidence: [],
            reasoning: `<img src=x onerror=alert(1)> & "quotes"`,
          },
          failureLogExcerpt: `<script>alert("log")</script>`,
        }),
      ]),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain(`<script>alert("log")`);
  });

  test("a </script> inside the data island cannot terminate it", () => {
    const html = renderRunReport(
      report([failedResult("complete", { failureLogExcerpt: "</script><b>pwn</b>" })]),
    );
    const island = html.split('id="ccqa-report-data">')[1]!.split("</script>")[0]!;
    expect(island).toContain("\\u003c/script>");
    const data = JSON.parse(island) as RunReportData;
    expect(data.results[0]!.failureLogExcerpt).toBe("</script><b>pwn</b>");
  });

  test("an all-pass run renders without the measurement panel", () => {
    const html = renderRunReport(report([passedResult("create")]));
    expect(html).not.toContain('id="measure-panel"');
    expect(html).toContain("1 passed");
    expect(html).toContain("0 failed");
  });

  test("a skipped analysis shows the reason and no radios", () => {
    const html = renderRunReport(
      report([
        failedResult("complete", {
          analysis: null,
          analysisSkipped: "no ANTHROPIC_API_KEY and no Claude login",
          driftIssues: null,
        }),
      ]),
    );
    expect(html).toContain("analysis skipped: no ANTHROPIC_API_KEY and no Claude login");
    expect(html).not.toContain('<input type="radio"');
    // No analyzed failure → no measurement panel either.
    expect(html).not.toContain('id="measure-panel"');
  });

  test("client JS contains no TS-template leftovers", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    // A stray ${ in the client script would have been swallowed by the outer
    // template literal; make sure none survived into the output either.
    const script = html.split("<script>")[1] ?? "";
    expect(script).not.toContain("${");
  });
});
