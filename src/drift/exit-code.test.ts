import { describe, expect, test } from "vitest";
import { determineExitCode } from "./exit-code.ts";
import type { DraftIssue } from "../types.ts";

function issue(severity: DraftIssue["severity"]): DraftIssue {
  return { severity, category: "assertable", stepId: null, message: "x" };
}

const target = { featureName: "f", specName: "s" };

describe("determineExitCode", () => {
  test("returns 0 when every spec has only OK findings", () => {
    expect(
      determineExitCode(
        [{ target, ok: true, issues: [issue("OK"), issue("OK")] }],
        "error",
      ),
    ).toBe(0);
  });

  test("returns 1 on ERROR regardless of threshold", () => {
    const results = [{ target, ok: true, issues: [issue("ERROR")] }];
    expect(determineExitCode(results, "error")).toBe(1);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("WARN passes under --severity error but fails under --severity warn", () => {
    const results = [{ target, ok: true, issues: [issue("WARN")] }];
    expect(determineExitCode(results, "error")).toBe(0);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("a spec-level error (LLM/parse failure) always fails", () => {
    const results = [{ target, ok: false, issues: [], error: "boom" }];
    expect(determineExitCode(results, "error")).toBe(1);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("empty results pass", () => {
    expect(determineExitCode([], "error")).toBe(0);
  });
});
