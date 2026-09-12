import { describe, expect, test } from "vitest";
import { renderJunitXml } from "./junit.ts";
import { RunReportDataSchema, type ReportCost, type RunReportData } from "./schema.ts";

/** A step's cost record with every field at its "nothing billed" value. */
function zeroCost(): ReportCost {
  return {
    totalCostUsd: null,
    durationApiMs: null,
    numTurns: null,
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    models: [],
  };
}

function baseReport(results: RunReportData["results"]): RunReportData {
  return {
    schemaVersion: 1,
    kind: "run",
    createdAt: "2026-06-10T00:00:00.000Z",
    runId: null,
    git: { head: "abc1234", base: null },
    model: null,
    language: null,
    promptVersion: "1",
    customPromptVersion: null,
    cost: null,
    results,
  };
}

/** Round-trips a fixture through the schema so a drifted fixture fails here, not silently. */
function parse(data: RunReportData): RunReportData {
  return RunReportDataSchema.parse(JSON.parse(JSON.stringify(data)));
}

describe("renderJunitXml", () => {
  test("suite counts, a failed live step's reasoning as the message, and step screenshots in system-out", () => {
    const passing: RunReportData["results"][number] = {
      feature: "tasks",
      spec: "create",
      title: "creates a task",
      target: "agent-browser",
      mode: "live",
      status: "passed",
      testCounts: null,
      durationMs: 2000,
      assertions: null,
      analysis: null,
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: {
        runId: "run-1",
        sessionName: "session-1",
        startedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 2000,
        cost: zeroCost(),
        steps: [
          {
            stepId: "step-01",
            source: "spec",
            instruction: "Click submit",
            expected: "The task appears in the list",
            status: "passed",
            reasoning: "the task appeared in the list",
            beforePng: "evidence/tasks/create/step-01-before.png",
            afterPng: "evidence/tasks/create/step-01-after.png",
            durationMs: 2000,
            cost: zeroCost(),
          },
        ],
      },
    };

    const failing: RunReportData["results"][number] = {
      feature: "tasks",
      spec: "complete",
      title: "complete a task",
      target: "agent-browser",
      mode: "live",
      status: "failed",
      testCounts: null,
      durationMs: 3000,
      assertions: null,
      // A row carries a whole-row `analysis` too; the failed step's own
      // reasoning must win over it as the JUnit failure message.
      analysis: {
        label: "PRODUCT_BUG",
        confidence: 0.5,
        evidence: [],
        reasoning: "unused fallback reasoning",
        headline: "unused fallback headline",
        recommendation: "",
      },
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: {
        runId: "run-2",
        sessionName: "session-2",
        startedAt: "2026-06-10T00:00:05.000Z",
        durationMs: 3000,
        cost: zeroCost(),
        steps: [
          {
            stepId: "step-01",
            source: "spec",
            instruction: "Click complete",
            expected: "The task moves to done",
            status: "passed",
            reasoning: "moved to done",
            beforePng: "evidence/tasks/complete/step-01-before.png",
            afterPng: "evidence/tasks/complete/step-01-after.png",
            durationMs: 1000,
            cost: zeroCost(),
          },
          {
            stepId: "step-02",
            source: "spec",
            instruction: "Check the status label",
            expected: "The status label shows Done",
            status: "failed",
            reasoning: "the status label still shows In progress",
            beforePng: "evidence/tasks/complete/step-02-before.png",
            afterPng: "evidence/tasks/complete/step-02-after.png",
            durationMs: 2000,
            cost: zeroCost(),
          },
        ],
      },
    };

    const xml = renderJunitXml(parse(baseReport([passing, failing])), {
      reportDir: "/repo/.ccqa/run",
      junitDir: "/repo/.ccqa/run",
    });

    expect(xml).toContain('<testsuite name="ccqa" tests="2" failures="1" skipped="0" time="5.000">');
    expect(xml).toContain('<testcase name="creates a task" classname="tasks/create" time="2.000">');
    expect(xml).toContain(
      "<system-out>evidence/tasks/create/step-01-before.png\nevidence/tasks/create/step-01-after.png</system-out>",
    );
    expect(xml).toContain('<failure message="the status label still shows In progress">');
    expect(xml).toContain("Step step-02 failed");
    expect(xml).toContain("Instruction: Check the status label");
    expect(xml).toContain("evidence/tasks/complete/step-02-before.png");
    expect(xml).toContain("evidence/tasks/complete/step-02-after.png");
    expect(xml).not.toContain("unused fallback headline");
  });

  test("a skipped row renders <skipped/> with its reason", () => {
    const skipped: RunReportData["results"][number] = {
      feature: "tasks",
      spec: "delete",
      title: null,
      target: "playwright",
      status: "skipped",
      skipReason: "target has no runCommand configured",
      testCounts: null,
      durationMs: null,
      assertions: null,
      analysis: null,
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: null,
    };

    const xml = renderJunitXml(parse(baseReport([skipped])), {
      reportDir: "/repo/.ccqa/run",
      junitDir: "/repo/.ccqa/run",
    });

    expect(xml).toContain('<testsuite name="ccqa" tests="1" failures="0" skipped="1" time="0.000">');
    expect(xml).toContain('<testcase name="tasks/delete" classname="tasks/delete" time="0.000">');
    expect(xml).toContain('<skipped message="target has no runCommand configured"/>');
  });

  test("escapes XML metacharacters and strips a control character, in both attributes and text", () => {
    const row: RunReportData["results"][number] = {
      feature: "tasks",
      spec: "create",
      title: 'Submit & <Continue> "now"',
      target: "agent-browser",
      mode: "live",
      status: "failed",
      testCounts: null,
      durationMs: 1000,
      assertions: null,
      analysis: null,
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: {
        runId: "run-1",
        sessionName: "session-1",
        startedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 1000,
        cost: zeroCost(),
        steps: [
          {
            stepId: "step-01",
            source: "spec",
            instruction: "Submit the form",
            expected: 'A "Saved" toast appears',
            status: "failed",
            // Trailing BEL (0x07): a control character XML 1.0 forbids outright.
            // DEL (\x7F) and a newline follow: XML 1.0 permits DEL, and a newline
            // must reach the `message` attribute as a numeric char ref or
            // attribute-value normalization would collapse it to a space.
            reasoning: "the response arrived\ncorrupted\x7F\u0007",
            beforePng: null,
            afterPng: null,
            durationMs: 1000,
            cost: zeroCost(),
          },
        ],
      },
    };

    const xml = renderJunitXml(parse(baseReport([row])), {
      reportDir: "/repo/.ccqa/run",
      junitDir: "/repo/.ccqa/run",
    });

    expect(xml).toContain('name="Submit &amp; &lt;Continue&gt; &quot;now&quot;"');
    expect(xml).toContain('message="the response arrived&#10;corrupted\x7F"');
    expect(xml).toContain("Reasoning: the response arrived\ncorrupted\x7F");
    expect(xml).not.toContain("\u0007");
    // No stray, unescaped `&`, `<` or `>` survives anywhere in the document.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|#10;|#13;|#9;)/);
    expect((xml.match(/</g) ?? []).length).toBe((xml.match(/>/g) ?? []).length);
  });

  test("re-expresses a row's evidence paths relative to the XML file's own directory", () => {
    const row: RunReportData["results"][number] = {
      feature: "tasks",
      spec: "create",
      title: "creates a task",
      target: "agent-browser",
      mode: "live",
      status: "passed",
      testCounts: null,
      durationMs: 1000,
      assertions: null,
      analysis: null,
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: {
        runId: "run-1",
        sessionName: "session-1",
        startedAt: "2026-06-10T00:00:00.000Z",
        durationMs: 1000,
        cost: zeroCost(),
        steps: [
          {
            stepId: "step-01",
            source: "spec",
            instruction: "Click submit",
            expected: "The task appears in the list",
            status: "passed",
            reasoning: "the task appeared in the list",
            beforePng: "evidence/tasks/create/step-01-before.png",
            afterPng: "evidence/tasks/create/step-01-after.png",
            durationMs: 1000,
            cost: zeroCost(),
          },
        ],
      },
    };

    // The XML lands two directories below the report dir, e.g.
    // `--report-junit ci/out/results.xml` next to a report at `.ccqa/run`.
    const xml = renderJunitXml(parse(baseReport([row])), {
      reportDir: "/repo/.ccqa/run",
      junitDir: "/repo/ci/out",
    });

    expect(xml).toContain(
      "<system-out>../../.ccqa/run/evidence/tasks/create/step-01-before.png\n" +
        "../../.ccqa/run/evidence/tasks/create/step-01-after.png</system-out>",
    );
  });
});
