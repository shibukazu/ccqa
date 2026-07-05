import { describe, expect, test } from "vitest";
import type { GradedCase } from "./custom-prompt.ts";
import { buildLearningUserPrompt } from "./custom-prompt-learning.ts";

function gradedCase(overrides: Partial<GradedCase> = {}): GradedCase {
  return {
    predicted: "TEST_DRIFT",
    actualCause: "TEST_DRIFT",
    evidenceSignal: "button not found",
    matches: true,
    ...overrides,
  };
}

describe("buildLearningUserPrompt", () => {
  test("lists each case with its label and evidence signal", () => {
    const prompt = buildLearningUserPrompt([
      gradedCase({ evidenceSignal: "selector renamed", actualCause: "TEST_DRIFT", matches: true }),
    ]);
    expect(prompt).toContain("1 graded failure classifications");
    expect(prompt).toContain("Case 1 (TEST_DRIFT; model was correct)");
    expect(prompt).toContain("selector renamed");
  });

  test("surfaces the model's mistake when prediction and actual differ", () => {
    const prompt = buildLearningUserPrompt([
      gradedCase({ predicted: "SPEC_CHANGE", actualCause: "PRODUCT_BUG", matches: false }),
    ]);
    expect(prompt).toContain("model predicted SPEC_CHANGE, human corrected to PRODUCT_BUG");
  });
});
