import { describe, test, expect } from "vitest";
import { parseStepResultLine, findLastStepResult } from "./nd-result-parse.ts";

describe("parseStepResultLine", () => {
  test("parses pass with reasoning", () => {
    expect(parseStepResultLine("STEP_RESULT|step-01|pass|Login form rendered"))
      .toEqual({ stepId: "step-01", status: "pass", reasoning: "Login form rendered" });
  });

  test("parses fail with reasoning", () => {
    expect(parseStepResultLine("STEP_RESULT|step-02|fail|Submit button stayed disabled"))
      .toEqual({ stepId: "step-02", status: "fail", reasoning: "Submit button stayed disabled" });
  });

  test("accepts empty reasoning", () => {
    expect(parseStepResultLine("STEP_RESULT|step-03|pass|"))
      .toEqual({ stepId: "step-03", status: "pass", reasoning: "" });
  });

  test("rejoins pipes inside reasoning", () => {
    expect(parseStepResultLine("STEP_RESULT|step-04|fail|url contains /a|b|c"))
      .toEqual({ stepId: "step-04", status: "fail", reasoning: "url contains /a|b|c" });
  });

  test("normalises status casing", () => {
    expect(parseStepResultLine("STEP_RESULT|step-05|PASS|ok"))
      .toEqual({ stepId: "step-05", status: "pass", reasoning: "ok" });
  });

  test("ignores leading and trailing whitespace", () => {
    expect(parseStepResultLine("   STEP_RESULT|step-06|pass|done   "))
      .toEqual({ stepId: "step-06", status: "pass", reasoning: "done" });
  });

  test("returns null when missing prefix", () => {
    expect(parseStepResultLine("step-01|pass|ok")).toBeNull();
  });

  test("returns null when missing stepId", () => {
    expect(parseStepResultLine("STEP_RESULT||pass|ok")).toBeNull();
  });

  test("returns null when status is not pass or fail", () => {
    expect(parseStepResultLine("STEP_RESULT|step-01|maybe|ok")).toBeNull();
  });

  test("returns null when only the prefix is present", () => {
    expect(parseStepResultLine("STEP_RESULT|")).toBeNull();
  });

  test("truncates very long reasoning", () => {
    const huge = "x".repeat(5000);
    const r = parseStepResultLine(`STEP_RESULT|step-01|fail|${huge}`);
    expect(r).not.toBeNull();
    expect(r!.reasoning.length).toBe(2000);
  });
});

describe("findLastStepResult", () => {
  test("returns the last STEP_RESULT line in a multi-line transcript", () => {
    const text = [
      "I will navigate to the page.",
      "STEP_RESULT|step-01|fail|first attempt",
      "Let me try again.",
      "STEP_RESULT|step-01|pass|second attempt worked",
    ].join("\n");
    expect(findLastStepResult(text))
      .toEqual({ stepId: "step-01", status: "pass", reasoning: "second attempt worked" });
  });

  test("returns null when no STEP_RESULT line is present", () => {
    expect(findLastStepResult("just some narrative text without the marker")).toBeNull();
  });

  test("tolerates CRLF line endings", () => {
    const text = "intro\r\nSTEP_RESULT|step-01|pass|ok\r\noutro";
    expect(findLastStepResult(text))
      .toEqual({ stepId: "step-01", status: "pass", reasoning: "ok" });
  });
});
