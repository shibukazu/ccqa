import { describe, expect, test } from "vitest";
import { determineExitCode } from "./exit-code.ts";
import type { DriftDiagnosis } from "../report/schema.ts";

function diagnosis(label: DriftDiagnosis["label"]): DriftDiagnosis {
  return {
    label,
    confidence: 0.8,
    surface: "spec",
    subDiagnosis: "NONE",
    headline: "x",
    recommendation: "",
    evidence: [],
    reasoning: "",
  };
}

const target = { featureName: "f", specName: "s" };

describe("determineExitCode", () => {
  test("returns 0 when every spec has no drift", () => {
    expect(determineExitCode([{ target, ok: true, drift: null }], "error")).toBe(0);
  });

  test("returns 1 on TEST_DRIFT/SPEC_CHANGE (error severity) regardless of threshold", () => {
    const results = [{ target, ok: true, drift: diagnosis("SPEC_CHANGE") }];
    expect(determineExitCode(results, "error")).toBe(1);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("UNKNOWN (warn severity) passes under --severity error but fails under --severity warn", () => {
    const results = [{ target, ok: true, drift: diagnosis("UNKNOWN") }];
    expect(determineExitCode(results, "error")).toBe(0);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("a spec-level error (LLM/parse failure) always fails", () => {
    const results = [{ target, ok: false, drift: null, error: "boom" }];
    expect(determineExitCode(results, "error")).toBe(1);
    expect(determineExitCode(results, "warn")).toBe(1);
  });

  test("empty results pass", () => {
    expect(determineExitCode([], "error")).toBe(0);
  });
});
