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
      outDir: "tests",
      extraWriteRoots: [],
    });
    expect(prompt).toContain(
      "- step-01: judge by LLM (read from `.out`)\n  claim: the answer explains why\n    and names a next action\n- step-02:",
    );
  });
});
