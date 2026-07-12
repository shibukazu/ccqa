import { describe, expect, test } from "vitest";
import { buildFailureAnalysisPrompt, type FailureAnalysisPromptInput } from "./prompt.ts";

const BASE_INPUT: FailureAnalysisPromptInput = {
  specYaml: "title: sample",
  diffPatch: null,
  changedFiles: null,
  baseRef: null,
  driftIssues: null,
};

const USER_HEADING = "## Project triage guidance (human-maintained)";
const CUSTOM_HEADING = "## Calibration guidance from human-graded past failures";

describe("buildFailureAnalysisPrompt guidance injection", () => {
  test("neither block renders when no guidance is supplied (backward compatibility)", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    expect(prompt).not.toContain(USER_HEADING);
    expect(prompt).not.toContain(CUSTOM_HEADING);
    expect(prompt).toBe(buildFailureAnalysisPrompt({ ...BASE_INPUT, triageUserPrompt: null, customPrompt: null }));
  });

  test("human triage.user guidance renders before the learned calibration, both before Output", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...BASE_INPUT,
      triageUserPrompt: "Treat copy changes on the settings screen as SPEC_CHANGE.",
      customPrompt: {
        schemaVersion: 1,
        basePromptVersion: "4",
        customPromptVersion: "v1",
        generatedAt: "t",
        guidance: "Prefer PRODUCT_BUG when the DOM is intact.",
      },
    });
    const userAt = prompt.indexOf(USER_HEADING);
    const customAt = prompt.indexOf(CUSTOM_HEADING);
    const outputAt = prompt.indexOf("## Output");
    expect(userAt).toBeGreaterThan(-1);
    expect(customAt).toBeGreaterThan(userAt);
    expect(outputAt).toBeGreaterThan(customAt);
    expect(prompt).toContain("Treat copy changes on the settings screen as SPEC_CHANGE.");
  });
});
