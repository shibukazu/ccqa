import { describe, expect, it } from "vitest";
import { buildLlmGenPrompt } from "./llm-gen.ts";

describe("buildLlmGenPrompt", () => {
  it("indents a claim's continuation lines so a block scalar stays one step", () => {
    const prompt = buildLlmGenPrompt({
      taskInstructions: "t",
      specTitle: "demo",
      steps: [
        { id: "step-01", source: "spec", judgeByLlm: "the answer explains why\nand names a next action", from: ".out" },
        { id: "step-02", source: "spec", instruction: "close", expected: "gone" },
      ],
      resources: [],
      conventionSections: [],
      testPath: "tests/demo.spec.ts",
      writeRoots: [],
    });
    expect(prompt).toContain(
      "- step-01: judge by LLM (read from `.out`)\n  claim: the answer explains why\n    and names a next action\n- step-02:",
    );
  });

  // Conventions key rules on these — which checks are the case's, where it may
  // run — so a rewrite that never saw them can only guess.
  it("states what the case says beyond its steps", () => {
    const prompt = buildLlmGenPrompt({
      taskInstructions: "t",
      specTitle: "demo",
      steps: [{ id: "step-01", source: "spec", instruction: "add an item", expected: "" }],
      expectations: ["the new item is on the list"],
      cleanup: [{ id: "cleanup-01", source: "spec", instruction: "delete the item", expected: "" }],
      cleanupExpectations: ["the list is empty again"],
      context: [{ heading: "Preconditions", body: "Runs against the staging environment only." }],
      resources: [],
      conventionSections: [],
      testPath: "tests/demo.spec.ts",
      writeRoots: [],
    });
    expect(prompt).toContain("## About this case");
    expect(prompt).toContain("- the new item is on the list");
    expect(prompt).toContain("- cleanup-01: delete the item");
    expect(prompt).toContain("- the list is empty again");
    expect(prompt).toContain("### Preconditions\n\nRuns against the staging environment only.");
  });
});
