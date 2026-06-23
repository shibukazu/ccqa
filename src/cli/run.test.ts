import { describe, expect, test } from "vitest";
import { buildFailureLog, failedSpec, TailBuffer, type SpecRunSummary } from "./run.ts";

// Minimal subset — `failedSpec` only reads `exitCode` and
// `report.numFailedTests`, so the report cast is safe.
function summary(name: string, opts: { passed: boolean }): SpecRunSummary {
  return {
    featureName: "feat",
    specName: name,
    scriptFile: `/tmp/${name}/test.spec.ts`,
    report: {
      numFailedTests: opts.passed ? 0 : 1,
      numPassedTests: opts.passed ? 1 : 0,
      success: opts.passed,
    } as SpecRunSummary["report"],
    exitCode: opts.passed ? 0 : 1,
    outputTail: null,
    evidenceDir: null,
  };
}

describe("failedSpec", () => {
  test("passing spec is not failed", () => {
    expect(failedSpec(summary("ok", { passed: true }))).toBe(false);
  });

  test("non-zero exit code is failed", () => {
    expect(failedSpec(summary("boom", { passed: false }))).toBe(true);
  });

  test("zero exit code but failed assertions counts as failed", () => {
    const s = summary("flaky", { passed: false });
    s.exitCode = 0;
    expect(failedSpec(s)).toBe(true);
  });

  test("no report falls back to exit code", () => {
    const s = summary("noreport", { passed: true });
    s.report = null;
    expect(failedSpec(s)).toBe(false);
    s.exitCode = 1;
    expect(failedSpec(s)).toBe(true);
  });
});

describe("buildFailureLog", () => {
  test("pulls failureMessages from the vitest JSON report (json reporter writes nothing to stdout)", () => {
    const s = summary("boom", { passed: false });
    s.report = {
      numFailedTests: 1,
      testResults: [
        {
          name: "test.spec.ts",
          status: "failed",
          assertionResults: [
            { status: "passed", title: "ok", fullName: "ok step" },
            {
              status: "failed",
              title: "boom",
              fullName: "boom step",
              failureMessages: ["AssertionError: expected 1 to be 2"],
            },
          ],
        },
      ],
    } as unknown as SpecRunSummary["report"];
    const out = buildFailureLog(s);
    expect(out).toContain("✖ boom step");
    expect(out).toContain("expected 1 to be 2");
    expect(out).not.toContain("ok step");
  });

  test("appends the raw output tail as secondary context", () => {
    const s = summary("boom", { passed: false });
    s.report = null;
    s.outputTail = "console.log noise\nagent-browser: click failed";
    const out = buildFailureLog(s);
    expect(out).toContain("--- vitest output (tail) ---");
    expect(out).toContain("click failed");
  });

  test("empty when there is neither a report nor output", () => {
    const s = summary("silent", { passed: false });
    s.report = null;
    expect(buildFailureLog(s)).toBe("");
  });
});

describe("TailBuffer", () => {
  test("returns everything under the cap", () => {
    const tail = new TailBuffer(100);
    tail.append("hello\n");
    tail.append("world\n");
    expect(tail.toString()).toBe("hello\nworld\n");
  });

  test("keeps only the tail once the cap is exceeded, with a marker", () => {
    const tail = new TailBuffer(10);
    for (let i = 0; i < 10; i++) tail.append(`line-${i}\n`);
    const out = tail.toString();
    expect(out).toContain("[...output truncated...]");
    expect(out).toContain("line-9");
    expect(out).not.toContain("line-0");
    // marker line + at most cap chars of payload
    expect(out.length).toBeLessThanOrEqual("[...output truncated...]\n".length + 10);
  });
});
