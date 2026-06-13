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
    evidence: null,
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
      headline: "Submit button aria-label was renamed in the diff",
      evidence: [{ file: "src/app.tsx:42", detail: "aria-label renamed" }],
      recommendation: "Update the selector in the test to the new aria-label",
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
    evidence: null,
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
    language: null,
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
    // Internal enum still appears in CSS class names and radio values (kept
    // stable for export labels + LLM JSON).
    expect(html).toContain("TEST_DRIFT");
    expect(html).toContain("85%");
    expect(html).toContain("SELECTOR_DRIFT");
    expect(html).toContain("aria-label renamed");
    expect(html).toContain("asserted copy no longer exists");
    for (const label of ["TEST_DRIFT", "SPEC_CHANGE", "PRODUCT_BUG"]) {
      expect(html).toContain(`value="${label}"`);
    }
    expect(html).toContain('id="metrics-summary"');
    expect(html).toContain('id="export-labels"');
    // Human-facing labels replace the enum in the visible chrome.
    expect(html).toContain(">Test drift<");
    expect(html).toContain(">Spec change<");
    expect(html).toContain(">Product bug<");
    // Each label gets a `?` help bubble explaining what the category means.
    expect(html).toContain("The product still behaves the way the spec describes");
  });

  test("escapes HTML in model output and logs", () => {
    const html = renderRunReport(
      report([
        failedResult("complete", {
          analysis: {
            label: "PRODUCT_BUG",
            confidence: 0.5,
            subDiagnosis: "NONE",
            headline: "<img onerror=alert(1)>",
            evidence: [],
            recommendation: `<script>alert("rec")</script>`,
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

  test("prediction accuracy panel uses 3 KPI tiles and 2 collapsible details", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    // Three named target divs for the client JS to write the summary tiles into.
    expect(html).toContain('id="metrics-summary"');
    // The matrix and per-class breakdown live behind their own collapsible details.
    expect(html).toContain('class="metrics-detail"');
    expect(html).toContain("Confusion matrix");
    expect(html).toContain("Per-class metrics");
    expect(html).toContain('id="metrics-matrix"');
    expect(html).toContain('id="metrics-perclass"');
    // Legacy flat panel must be gone — no `<div id="metrics">` and no `.stats`.
    expect(html).not.toMatch(/id="metrics"[^-]/);
    expect(html).not.toContain('class="stats"');
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

  test("renders step-evidence with labelled URL/Page footer rows under the expected text", () => {
    const html = renderRunReport(
      report([
        passedResult("create"),
        {
          ...passedResult("complete"),
          evidence: [
            {
              stepId: "step-01",
              source: "spec",
              pngPath: "evidence/tasks/complete/step-01.png",
              url: "https://app.example.com/dashboard?foo=bar",
              title: "Dashboard | Example",
              capturedAt: "2026-06-13T00:00:00.000Z",
              description: "Redirected to /dashboard, user avatar visible in the header",
              status: "passed",
              failureSummary: null,
            },
          ],
        },
      ]),
    );
    expect(html).toContain("Step evidence (1)");
    expect(html).toContain('src="evidence/tasks/complete/step-01.png"');
    // Expected text from spec.yaml is the main caption line.
    expect(html).toContain("Redirected to /dashboard, user avatar visible in the header");
    // Footer shows labelled rows so reviewers don't have to guess what they're looking at.
    expect(html).toContain(">URL<");
    expect(html).toContain(">Page<");
    expect(html).toContain("Dashboard | Example");
    // URL is shortened (no scheme, no query) but the full value lives in the title attribute.
    expect(html).toContain("app.example.com/dashboard");
    expect(html).not.toMatch(/>\s*https:\/\/app\.example\.com\/dashboard\?foo=bar\s*</);
    expect(html).toContain('title="https://app.example.com/dashboard?foo=bar"');
    // The internal `[spec]` / `[login]` source tag must not leak into the caption.
    expect(html).not.toMatch(/\[spec\]/);
    expect(html).not.toMatch(/\[login\]/);
  });

  test("failed evidence card carries a FAILED badge, red frame, and the failure summary", () => {
    const html = renderRunReport(
      report([
        {
          ...failedResult("complete"),
          evidence: [
            {
              stepId: "step-01",
              source: "spec",
              pngPath: "evidence/tasks/complete/step-01.png",
              url: "https://app.example.com/list",
              title: "List",
              capturedAt: "2026-06-13T00:00:00.000Z",
              description: "List loads with at least one row",
              status: "passed",
              failureSummary: null,
            },
            {
              stepId: "step-02",
              source: "spec",
              pngPath: "evidence/tasks/complete/step-02.png",
              url: "https://app.example.com/detail",
              title: "Detail",
              capturedAt: "2026-06-13T00:00:01.000Z",
              description: "Detail page shows the row I clicked",
              status: "failed",
              failureSummary: "Assertion failed: expected 'Saved' to be visible after 30000ms",
            },
          ],
        },
      ]),
    );
    expect(html).toContain("evidence-thumb-passed");
    expect(html).toContain("evidence-thumb-failed");
    expect(html).toContain("evidence-status-passed");
    expect(html).toContain("evidence-status-failed");
    expect(html).toContain(">PASSED<");
    expect(html).toContain(">FAILED<");
    // Failure summary surfaces in the red bottom block.
    expect(html).toContain("evidence-failure");
    expect(html).toContain("expected &#39;Saved&#39; to be visible");
    // Failed step keeps its spec.yaml expected as the main caption line.
    expect(html).toContain("Detail page shows the row I clicked");
  });

  test("collapsible sections carry plain-language labels plus help bubbles", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    // Old labels replaced with descriptive ones.
    expect(html).toContain("Failure log");
    expect(html).toContain("Source diff for this spec");
    expect(html).toContain("Test definition (spec.yaml)");
    expect(html).toContain("Spec vs code audit");
    // The ⓘ bubble is present on each of those sections.
    const helpCount = (html.match(/class="help"/g) ?? []).length;
    expect(helpCount).toBeGreaterThanOrEqual(4);
    // The tooltip element is built into the DOM (CSS-driven, opens on hover
    // AND keyboard focus — the native `title` attribute alone only fires on
    // hover, which the user reported as broken).
    expect(html).toContain('class="help-tip"');
    expect(html).toContain("The raw stdout/stderr");
  });

  test("renders the report in Japanese when data.language is ja", () => {
    const data = report([failedResult("complete")]);
    data.language = "ja";
    const html = renderRunReport(data);
    // Header / chrome translated.
    expect(html).toContain("ccqa 実行レポート");
    expect(html).toContain("予測精度");
    // KPI tile labels live in a strings data island consumed by the client JS.
    expect(html).toContain("採点済み");
    expect(html).toContain("正解率");
    expect(html).toContain("未採点");
    // Collapsible labels translated.
    expect(html).toContain("失敗ログ");
    expect(html).toContain("この spec に関連する差分");
    expect(html).toContain("テスト定義 (spec.yaml)");
    expect(html).toContain("実際の原因");
    expect(html).toContain("推奨アクション");
    expect(html).toContain("未採点");
    expect(html).toContain("サブ原因");
    // Failure labels translated into human language.
    expect(html).toContain("テスト側のずれ");
    expect(html).toContain("spec の変更");
    expect(html).toContain("プロダクトのバグ");
    // The html element advertises the language for accessibility / fonts.
    expect(html).toContain('<html lang="ja">');
    // Sanity: English chrome strings should NOT leak through.
    expect(html).not.toContain("Prediction accuracy");
    expect(html).not.toContain(">Failure log<");
  });

  test("falls back to English when data.language is unknown / null", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    expect(html).toContain("Prediction accuracy");
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("予測精度");
  });

  test("failed-with-analysis specs get a Needs grading chip and a hierarchical sub-cause line", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    // Needs-grading chip — client JS hides it once a radio is picked.
    expect(html).toContain('class="needs-grading-chip"');
    expect(html).toContain(">Needs grading<");
    // Sub-cause is rendered as a parent → child line under the main label.
    expect(html).toContain('class="sub-cause"');
    expect(html).toContain("Sub-cause");
    expect(html).toContain("SELECTOR_DRIFT");
    // The legacy flat .sub pill must be gone from the prediction row.
    expect(html).not.toMatch(/<span class="sub">SELECTOR_DRIFT<\/span>/);
  });

  test("dropped the prompt version meta from the header", () => {
    // promptVersion is still in the data schema for export comparison, but
    // showing it in the human-facing header was noise.
    const html = renderRunReport(report([passedResult("create")]));
    expect(html).not.toMatch(/prompt\s*v\d/i);
  });

  test("client JS contains no TS-template leftovers", () => {
    const html = renderRunReport(report([failedResult("complete")]));
    // A stray ${ in the client script would have been swallowed by the outer
    // template literal; make sure none survived into the output either.
    const script = html.split("<script>")[1] ?? "";
    expect(script).not.toContain("${");
  });
});
