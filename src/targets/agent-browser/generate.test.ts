import { describe, expect, it } from "vitest";
import { findEmptySteps, reattachStepIds } from "./generate.ts";
import type { ExpandedActionStep } from "../../spec/expand.ts";
import type { RecordedAction } from "../../types.ts";

function step(id: string, source = "spec"): ExpandedActionStep {
  return { id, source, instruction: "", expected: "" };
}

const css = (value: string) => ({ by: "css", value }) as const;

/**
 * The cleanup Claude pass returns a pruned action array without `stepId`
 * because the prompt deliberately doesn't surface that field.
 * `reattachStepIds` re-pairs cleaned actions with originals so codegen
 * can keep emitting accurate `// step:` comments.
 */
describe("reattachStepIds", () => {
  it("re-tags cleaned actions with the matching original's stepId", () => {
    const original: RecordedAction[] = [
      { action: "cookies_clear", stepId: "step-01" },
      { action: "navigate", value: "https://idp/", stepId: "step-01" },
      { action: "snapshot", observation: "login form", stepId: "step-01" },
      { action: "fill", locator: css("[type='email']"), value: "$EMAIL", stepId: "step-02" },
      { action: "fill", locator: css("[type='password']"), value: "$PW", stepId: "step-02" },
      { action: "press", value: "Enter", stepId: "step-02" },
      { action: "navigate", value: "https://app/", stepId: "step-03" },
    ];
    // The cleanup pass typically drops snapshots / failed attempts; here it
    // keeps the meaningful actions but strips stepId (mirroring the Claude
    // contract).
    const cleaned: RecordedAction[] = [
      { action: "cookies_clear" },
      { action: "navigate", value: "https://idp/" },
      { action: "fill", locator: css("[type='email']"), value: "$EMAIL" },
      { action: "fill", locator: css("[type='password']"), value: "$PW" },
      { action: "press", value: "Enter" },
      { action: "navigate", value: "https://app/" },
    ];

    const result = reattachStepIds(cleaned, original);
    expect(result.map((a) => a.stepId)).toEqual([
      "step-01",
      "step-01",
      "step-02",
      "step-02",
      "step-02",
      "step-03",
    ]);
  });

  it("matches duplicate fills forward — second cleaned fill maps to the second original", () => {
    const original: RecordedAction[] = [
      { action: "fill", locator: css("x"), value: "v", stepId: "step-01" },
      { action: "fill", locator: css("x"), value: "v", stepId: "step-02" },
    ];
    const cleaned: RecordedAction[] = [
      { action: "fill", locator: css("x"), value: "v" },
      { action: "fill", locator: css("x"), value: "v" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result.map((a) => a.stepId)).toEqual(["step-01", "step-02"]);
  });

  it("leaves stepId unset for cleaned actions that have no matching original", () => {
    const original: RecordedAction[] = [
      { action: "fill", locator: css("x"), value: "real", stepId: "step-01" },
    ];
    // Claude (in violation of the prompt) invented an extra action.
    const cleaned: RecordedAction[] = [
      { action: "fill", locator: css("x"), value: "real" },
      { action: "fill", locator: css("y"), value: "fake" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result[0]!.stepId).toBe("step-01");
    expect(result[1]!.stepId).toBeUndefined();
  });

  it("returns cleaned actions unchanged when no original has a stepId", () => {
    const original: RecordedAction[] = [
      { action: "navigate", value: "u" },
    ];
    const cleaned: RecordedAction[] = [
      { action: "navigate", value: "u" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result[0]!.stepId).toBeUndefined();
  });

  it("restores the locator cluster when the cleanup pass dropped it", () => {
    // Regression: the LLM cleanup pass occasionally returns a kept action as
    // just `{ action: "click" }`, leaving codegen with nothing to target.
    // reattachStepIds is the last line of defence — it re-pairs the cleaned
    // entry with its original and restores the missing locator + index.
    const original: RecordedAction[] = [
      { action: "click", locator: css("[data-qa='reply']"), index: "last", stepId: "step-10" },
    ];
    const cleaned: RecordedAction[] = [
      { action: "click" },
    ];
    const [result] = reattachStepIds(cleaned, original);
    expect(result?.locator).toEqual({ by: "css", value: "[data-qa='reply']" });
    expect(result?.index).toBe("last");
    expect(result?.stepId).toBe("step-10");
  });

  it("does not overwrite a locator the cleanup pass already kept", () => {
    const original: RecordedAction[] = [
      { action: "click", locator: { by: "text", value: "Reply" }, stepId: "step-04" },
      { action: "click", locator: css("[data-qa='reply']"), index: "last", stepId: "step-04" },
    ];
    // Cleanup correctly kept only the second (successful) attempt.
    const cleaned: RecordedAction[] = [
      { action: "click", locator: css("[data-qa='reply']"), index: "last" },
    ];
    const [result] = reattachStepIds(cleaned, original);
    expect(result?.locator).toEqual({ by: "css", value: "[data-qa='reply']" });
    expect(result?.index).toBe("last");
    expect(result?.stepId).toBe("step-04");
  });

  it("restores replayUnstable / replayReason that the cleanup pass dropped", () => {
    const original: RecordedAction[] = [
      {
        action: "click",
        locator: css("[aria-label='X']"),
        stepId: "step-04",
        replayUnstable: true,
        replayReason: "✗ Element not found",
      },
    ];
    const cleaned: RecordedAction[] = [
      { action: "click", locator: css("[aria-label='X']") },
    ];
    const [result] = reattachStepIds(cleaned, original);
    expect(result?.replayUnstable).toBe(true);
    expect(result?.replayReason).toBe("✗ Element not found");
    expect(result?.stepId).toBe("step-04");
  });
});

describe("findEmptySteps", () => {
  it("flags spec steps with no surviving actions", () => {
    const steps = [step("step-01"), step("step-02"), step("step-03")];
    const actions: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='X']"), stepId: "step-03" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-02", source: "spec", insertAfterIndex: 0 },
    ]);
  });

  it("uses insertAfterIndex = -1 when a step before any survivor is empty", () => {
    const steps = [step("step-01"), step("step-02")];
    const actions: RecordedAction[] = [
      { action: "click", locator: css("[aria-label='Y']"), stepId: "step-02" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-01", source: "spec", insertAfterIndex: -1 },
    ]);
  });

  it("returns nothing when every step survived", () => {
    const steps = [step("step-01"), step("step-02")];
    const actions: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
      { action: "click", locator: css("[aria-label='Y']"), stepId: "step-02" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([]);
  });

  it("handles a tail of consecutive lost steps", () => {
    const steps = [step("step-01"), step("step-02"), step("step-03")];
    const actions: RecordedAction[] = [
      { action: "navigate", value: "/", stepId: "step-01" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-02", source: "spec", insertAfterIndex: 0 },
      { stepId: "step-03", source: "spec", insertAfterIndex: 0 },
    ]);
  });
});
