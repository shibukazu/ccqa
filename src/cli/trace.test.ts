import { describe, test, expect } from "vitest";
import { createStepTracker, parseStatusLine, countRedundantByStep } from "./trace.ts";
import type { RecordedAction } from "../types.ts";

describe("createStepTracker", () => {
  test("CCQA_STEP prefix wins over the STEP_START text channel and advances it", () => {
    const t = createStepTracker();
    t.fromStepStartLine("step-01");
    expect(t.fromCommand("step-02")).toBe("step-02");
    // Later text-channel lines (AB_ACTION|assert|...) follow the prefix.
    expect(t.current()).toBe("step-02");
  });

  test("falls back to the STEP_START text channel when a command has no prefix", () => {
    const t = createStepTracker();
    t.fromStepStartLine("step-01");
    expect(t.fromCommand(undefined)).toBe("step-01");
  });

  test("returns undefined before either channel has reported a step", () => {
    const t = createStepTracker();
    expect(t.fromCommand(undefined)).toBeUndefined();
    expect(t.current()).toBeUndefined();
  });
});

describe("parseStatusLine", () => {
  test("parses STEP_START", () => {
    expect(parseStatusLine("STEP_START|step-01|Login")).toEqual({
      type: "STEP_START",
      stepId: "step-01",
      detail: "Login",
    });
  });

  test("parses STEP_DONE", () => {
    expect(parseStatusLine("STEP_DONE|step-01|Verified redirect")).toEqual({
      type: "STEP_DONE",
      stepId: "step-01",
      detail: "Verified redirect",
    });
  });

  test("parses ASSERTION_FAILED", () => {
    expect(parseStatusLine("ASSERTION_FAILED|step-03|app-bug: button not disabled")).toEqual({
      type: "ASSERTION_FAILED",
      stepId: "step-03",
      detail: "app-bug: button not disabled",
    });
  });

  test("parses STEP_SKIPPED", () => {
    expect(parseStatusLine("STEP_SKIPPED|step-02|previous step failed")).toEqual({
      type: "STEP_SKIPPED",
      stepId: "step-02",
      detail: "previous step failed",
    });
  });

  test("parses RUN_COMPLETED passed", () => {
    expect(parseStatusLine("RUN_COMPLETED|passed|All steps done")).toEqual({
      type: "RUN_COMPLETED",
      stepId: "passed",
      detail: "All steps done",
    });
  });

  test("returns null for non-matching lines", () => {
    expect(parseStatusLine("some random text")).toBeNull();
    expect(parseStatusLine("")).toBeNull();
    expect(parseStatusLine("AB_ACTION|click|[aria-label='X']|X")).toBeNull();
  });

  test("returns first matching line from multi-line text", () => {
    const text = "some preamble\nSTEP_START|step-01|Title\nmore text";
    expect(parseStatusLine(text)).toEqual({
      type: "STEP_START",
      stepId: "step-01",
      detail: "Title",
    });
  });
});

describe("countRedundantByStep", () => {
  const fill = (o: Partial<RecordedAction>): RecordedAction => ({ action: "fill", ...o });

  test("same value via two different locators on one step counts as 1 redundant", () => {
    const actions = [
      fill({ stepId: "step-01", locator: { by: "css", value: "[aria-label='Email']" }, value: "${EMAIL}" }),
      fill({ stepId: "step-01", locator: { by: "label", value: "Email" }, value: "${EMAIL}" }),
    ];
    expect(countRedundantByStep(actions).get("step-01")).toBe(1);
  });

  test("different values (email vs password) are not redundant", () => {
    const actions = [
      fill({ stepId: "step-01", locator: { by: "css", value: "#email" }, value: "${EMAIL}" }),
      fill({ stepId: "step-01", locator: { by: "css", value: "#password" }, value: "${PASSWORD}" }),
    ];
    expect(countRedundantByStep(actions).has("step-01")).toBe(false);
  });

  test("trivial values (bare numbers) never count, even via two locators", () => {
    const actions = [
      fill({ stepId: "step-01", locator: { by: "css", value: "#a" }, value: "100" }),
      fill({ stepId: "step-01", locator: { by: "css", value: "#b" }, value: "100" }),
    ];
    expect(countRedundantByStep(actions).has("step-01")).toBe(false);
  });

  test("same value via the same locator is not redundant (a legit re-fill)", () => {
    const actions = [
      fill({ stepId: "step-01", locator: { by: "css", value: "#email" }, value: "${EMAIL}" }),
      fill({ stepId: "step-01", locator: { by: "css", value: "#email" }, value: "${EMAIL}" }),
    ];
    expect(countRedundantByStep(actions).has("step-01")).toBe(false);
  });
});
