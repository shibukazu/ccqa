import { describe, expect, it } from "vitest";
import { stepDigests, unchangedSteps } from "./step-digests.ts";

const step = (id: string, instruction: string, expected = "") => ({ id, source: "spec", instruction, expected });
const testCase = (steps: ReturnType<typeof step>[]) => ({
  steps,
  cleanup: [],
  expectations: [],
  cleanupExpectations: [],
  context: [],
});
const recorded = stepDigests(testCase([step("step-01", "Open the page"), step("step-02", "Type and send")]));

describe("unchangedSteps", () => {
  it("keeps the unchanged steps and drops an edited one", () => {
    const now = stepDigests(testCase([step("step-01", "Open the page"), step("step-02", "Type", "a preview appears")]));
    expect([...unchangedSteps(recorded, now)].sort()).toEqual(["setup", "step-01"]);
  });


  it("keeps nothing from a recording that carries no digests", () => {
    expect(unchangedSteps(undefined, recorded).size).toBe(0);
  });
});
