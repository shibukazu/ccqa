import { describe, expect, it } from "vitest";
import { findEmptySteps, reattachStepIds } from "./generate.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";
import type { TraceAction } from "../types.ts";

function step(id: string, source = "spec"): ExpandedActionStep {
  return { id, source, instruction: "", expected: "" };
}

/**
 * The cleanup Claude pass returns a pruned action array without `stepId`
 * because the prompt deliberately doesn't surface that field.
 * `reattachStepIds` re-pairs cleaned actions with originals so codegen
 * can keep emitting accurate `// step:` comments.
 */
describe("reattachStepIds", () => {
  it("re-tags cleaned actions with the matching original's stepId", () => {
    const original: TraceAction[] = [
      { command: "cookies_clear", stepId: "step-01" },
      { command: "open", value: "https://idp/", stepId: "step-01" },
      { command: "snapshot", observation: "login form", stepId: "step-01" },
      { command: "fill", selector: "[type='email']", value: "$EMAIL", stepId: "step-02" },
      { command: "fill", selector: "[type='password']", value: "$PW", stepId: "step-02" },
      { command: "press", value: "Enter", stepId: "step-02" },
      { command: "open", value: "https://app/", stepId: "step-03" },
    ];
    // The cleanup pass typically drops snapshots / failed attempts; here it
    // keeps the meaningful actions but strips stepId (mirroring the Claude
    // contract).
    const cleaned: TraceAction[] = [
      { command: "cookies_clear" },
      { command: "open", value: "https://idp/" },
      { command: "fill", selector: "[type='email']", value: "$EMAIL" },
      { command: "fill", selector: "[type='password']", value: "$PW" },
      { command: "press", value: "Enter" },
      { command: "open", value: "https://app/" },
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
    const original: TraceAction[] = [
      { command: "fill", selector: "x", value: "v", stepId: "step-01" },
      { command: "fill", selector: "x", value: "v", stepId: "step-02" },
    ];
    const cleaned: TraceAction[] = [
      { command: "fill", selector: "x", value: "v" },
      { command: "fill", selector: "x", value: "v" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result.map((a) => a.stepId)).toEqual(["step-01", "step-02"]);
  });

  it("leaves stepId unset for cleaned actions that have no matching original", () => {
    const original: TraceAction[] = [
      { command: "fill", selector: "x", value: "real", stepId: "step-01" },
    ];
    // Claude (in violation of the prompt) invented an extra action.
    const cleaned: TraceAction[] = [
      { command: "fill", selector: "x", value: "real" },
      { command: "fill", selector: "y", value: "fake" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result[0]!.stepId).toBe("step-01");
    expect(result[1]!.stepId).toBeUndefined();
  });

  it("returns cleaned actions unchanged when no original has a stepId", () => {
    const original: TraceAction[] = [
      { command: "open", value: "u" },
    ];
    const cleaned: TraceAction[] = [
      { command: "open", value: "u" },
    ];
    const result = reattachStepIds(cleaned, original);
    expect(result[0]!.stepId).toBeUndefined();
  });

  it("restores find_* fields when the cleanup pass dropped them", () => {
    // Regression: the LLM cleanup prompt previously didn't surface
    // findLocator/findValue, so a kept find_click came back as just
    // `{ command: "find_click" }` and codegen had nothing to work with.
    // reattachStepIds is the last line of defence — it re-pairs the
    // cleaned entry with its original and restores the missing fields.
    const original: TraceAction[] = [
      { command: "find_click", findLocator: "last", findValue: "[data-qa='reply']", stepId: "step-10" },
    ];
    const cleaned: TraceAction[] = [
      { command: "find_click" },
    ];
    const [result] = reattachStepIds(cleaned, original);
    expect(result?.findLocator).toBe("last");
    expect(result?.findValue).toBe("[data-qa='reply']");
    expect(result?.stepId).toBe("step-10");
  });

  it("does not overwrite find_* fields that the cleanup pass already kept", () => {
    const original: TraceAction[] = [
      { command: "find_click", findLocator: "text", findValue: "Reply", stepId: "step-04" },
      { command: "find_click", findLocator: "last", findValue: "[data-qa='reply']", stepId: "step-04" },
    ];
    // Cleanup correctly kept only the second (successful) attempt.
    const cleaned: TraceAction[] = [
      { command: "find_click", findLocator: "last", findValue: "[data-qa='reply']" },
    ];
    const [result] = reattachStepIds(cleaned, original);
    expect(result?.findLocator).toBe("last");
    expect(result?.findValue).toBe("[data-qa='reply']");
    expect(result?.stepId).toBe("step-04");
  });

  it("keeps optional find fields (findName / findIndex / findExact) when borrowing", () => {
    const original: TraceAction[] = [
      { command: "find_click", findLocator: "role", findValue: "button", findName: "Submit", findExact: true, stepId: "step-02" },
      { command: "find_click", findLocator: "nth", findValue: "button.reply", findIndex: 2, stepId: "step-02" },
    ];
    const cleaned: TraceAction[] = [
      { command: "find_click", findLocator: "role", findValue: "button" },
      { command: "find_click", findLocator: "nth", findValue: "button.reply" },
    ];
    const [a, b] = reattachStepIds(cleaned, original);
    expect(a?.findName).toBe("Submit");
    expect(a?.findExact).toBe(true);
    expect(b?.findIndex).toBe(2);
  });
});

describe("findEmptySteps", () => {
  it("flags spec steps with no surviving actions", () => {
    const steps = [step("step-01"), step("step-02"), step("step-03")];
    const actions: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='X']", stepId: "step-03" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-02", source: "spec", insertAfterIndex: 0 },
    ]);
  });

  it("uses insertAfterIndex = -1 when a step before any survivor is empty", () => {
    const steps = [step("step-01"), step("step-02")];
    const actions: TraceAction[] = [
      { command: "click", selector: "[aria-label='Y']", stepId: "step-02" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-01", source: "spec", insertAfterIndex: -1 },
    ]);
  });

  it("returns nothing when every step survived", () => {
    const steps = [step("step-01"), step("step-02")];
    const actions: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
      { command: "click", selector: "[aria-label='Y']", stepId: "step-02" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([]);
  });

  it("handles a tail of consecutive lost steps", () => {
    const steps = [step("step-01"), step("step-02"), step("step-03")];
    const actions: TraceAction[] = [
      { command: "open", value: "/", stepId: "step-01" },
    ];
    expect(findEmptySteps(steps, actions)).toEqual([
      { stepId: "step-02", source: "spec", insertAfterIndex: 0 },
      { stepId: "step-03", source: "spec", insertAfterIndex: 0 },
    ]);
  });
});
