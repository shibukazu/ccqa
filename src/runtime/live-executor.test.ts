import { describe, expect, test } from "vitest";
import {
  judgeStepOutcome,
  scrubLiveStepText,
  shouldAskForVerdict,
  type LiveStepResult,
} from "./live-executor.ts";

const step = { id: "step-01", source: "spec", instruction: "open the page", expected: "it opens" };

describe("judgeStepOutcome", () => {
  test("reports why the invocation failed, not only that it did", () => {
    const { status, reasoning } = judgeStepOutcome({
      step,
      isError: true,
      errorDetail: "Native CLI binary for linux-x64 not found.",
      judged: null,
    });
    expect(status).toBe("failed");
    expect(reasoning).toContain("Native CLI binary for linux-x64 not found.");
  });

  test("keeps the model's own reasoning alongside the failure cause", () => {
    const { reasoning } = judgeStepOutcome({
      step,
      isError: true,
      errorDetail: "SDK reported error_max_turns",
      judged: { stepId: "step-01", status: "fail", reasoning: "button never appeared" },
    });
    expect(reasoning).toContain("SDK reported error_max_turns");
    expect(reasoning).toContain("button never appeared");
  });

  test("stays readable when the SDK gave no detail", () => {
    const { reasoning } = judgeStepOutcome({ step, isError: true, errorDetail: null, judged: null });
    expect(reasoning).toBe("Claude invocation returned an error");
  });

  test("leaves passing verdicts untouched", () => {
    const { status, reasoning } = judgeStepOutcome({
      step,
      isError: false,
      errorDetail: null,
      judged: { stepId: "step-01", status: "pass", reasoning: "the page opened" },
    });
    expect(status).toBe("passed");
    expect(reasoning).toBe("the page opened");
  });
});

describe("scrubLiveStepText", () => {
  test("masks a resolved value the model quoted back into its own text", () => {
    const recorded: LiveStepResult = {
      stepId: "step-01",
      source: "spec",
      instruction: "sign in as ${LOGIN_EMAIL}",
      expected: "the app opens",
      status: "passed",
      reasoning: "signed in as qa-user@example.com, the app opened",
      beforePng: null,
      afterPng: null,
      logTxt: null,
      durationMs: 1,
      cost: {
        totalCostUsd: null,
        durationApiMs: null,
        numTurns: null,
        inputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        outputTokens: null,
        models: [],
      },
      commands: ['agent-browser fill "#email" "qa-user@example.com"'],
    };

    const scrubbed = scrubLiveStepText(recorded, [["qa-user@example.com", "${LOGIN_EMAIL}"]]);

    expect(scrubbed.reasoning).toBe("signed in as ${LOGIN_EMAIL}, the app opened");
    expect(scrubbed.commands).toEqual(['agent-browser fill "#email" "${LOGIN_EMAIL}"']);
  });
});

describe("shouldAskForVerdict", () => {
  const asked = (over: Partial<Parameters<typeof shouldAskForVerdict>[0]>) =>
    shouldAskForVerdict({ judged: null, isError: false, transcript: "I waited; nothing.", ...over });

  test("asks when a clean turn left a report but no verdict", () => {
    expect(asked({})).toBe(true);
  });

  test("does not ask when the model already ruled", () => {
    expect(asked({ judged: { stepId: "step-01", status: "pass", reasoning: "ok" } })).toBe(false);
  });

  test("does not ask when the invocation errored or hit the ceiling", () => {
    // The failure is itself the answer, and re-judging it could turn a host
    // timeout into a pass.
    expect(asked({ isError: true })).toBe(false);
  });

  test("does not ask when nothing was written — there is nothing to judge from", () => {
    expect(asked({ transcript: "   \n  " })).toBe(false);
  });
});
