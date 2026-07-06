import { describe, expect, test } from "vitest";
import type { DraftIssue } from "../types.ts";
import { driftResultsToReport } from "./to-report.ts";
import type { SpecResult } from "./types.ts";

function issue(overrides: Partial<DraftIssue> = {}): DraftIssue {
  return {
    severity: "WARN",
    category: "assertable",
    stepId: "s1",
    message: "step asserts removed copy",
    detail: null,
    ...overrides,
  };
}

function result(overrides: Partial<SpecResult> = {}): SpecResult {
  return {
    target: { featureName: "tasks", specName: "create" },
    ok: true,
    issues: [],
    ...overrides,
  };
}

const meta = {
  threshold: "error" as const,
  git: { head: "abc1234", base: "origin/main" },
};

describe("driftResultsToReport", () => {
  test("clean specs are all passed and top-level kind is drift", () => {
    const report = driftResultsToReport([result(), result({ target: { featureName: "tasks", specName: "complete" } })], meta);
    expect(report.kind).toBe("drift");
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed"]);
  });

  test("a spec with an ERROR issue is failed", () => {
    const report = driftResultsToReport([result({ issues: [issue({ severity: "ERROR" })] })], meta);
    expect(report.results[0]!.status).toBe("failed");
  });

  test("driftIssues carries the issue array through unchanged", () => {
    const issues = [issue(), issue({ severity: "ERROR", message: "other" })];
    const report = driftResultsToReport([result({ issues })], meta);
    expect(report.results[0]!.driftIssues).toEqual(issues);
  });

  test("a spec with a call error is failed regardless of issues", () => {
    const report = driftResultsToReport([result({ error: "claude call failed" })], meta);
    expect(report.results[0]!.status).toBe("failed");
  });
});
