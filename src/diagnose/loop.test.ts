import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIDENCE_THRESHOLD, decide } from "./loop.ts";
import type { DiagnosisResult } from "./types.ts";

function result(confidence: number): DiagnosisResult {
  return {
    diagnosis: { type: "SELECTOR_DRIFT", oldSelector: "x", newSelector: "y", line: 1, reason: "" },
    confidence,
    reasoning: "",
  };
}

describe("decide", () => {
  test("auto mode still skips low-confidence diagnoses (the threshold gates every mode)", () => {
    // Regression: previously `auto` bypassed the threshold and applied
    // 0.20-confidence selector swaps over working code. CI should fail
    // visibly, not silently corrupt the script.
    expect(decide(result(0.2), "auto")).toBe("skip-low-confidence");
  });

  test("auto mode applies when confidence is at or above the threshold", () => {
    expect(decide(result(DEFAULT_CONFIDENCE_THRESHOLD), "auto")).toBe("apply-auto");
    expect(decide(result(0.95), "auto")).toBe("apply-auto");
  });

  test("non-interactive mode behaves identically to auto", () => {
    expect(decide(result(0.2), "non-interactive")).toBe("skip-low-confidence");
    expect(decide(result(0.9), "non-interactive")).toBe("apply-auto");
  });

  test("interactive mode falls through to a prompt below the threshold", () => {
    expect(decide(result(0.2), "interactive")).toBe("interactive");
    expect(decide(result(0.9), "interactive")).toBe("apply-auto");
  });

  test("threshold boundary is inclusive", () => {
    const justBelow = DEFAULT_CONFIDENCE_THRESHOLD - 0.0001;
    expect(decide(result(justBelow), "auto")).toBe("skip-low-confidence");
    expect(decide(result(DEFAULT_CONFIDENCE_THRESHOLD), "auto")).toBe("apply-auto");
  });
});
