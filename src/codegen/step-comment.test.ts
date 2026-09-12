import { describe, expect, it } from "vitest";
import { parseStepComment, renderStepComment } from "./step-comment.ts";

describe("renderStepComment / parseStepComment", () => {
  it("round-trips the identifier form for a spec.yaml step", () => {
    const marker = { stepId: "step-01", source: "spec" };
    const comment = renderStepComment(marker);
    expect(comment).toBe("// step: step-01 [spec]");
    expect(parseStepComment(comment)).toBe("step-01");
  });

  it("renders a case step's cited form in English, and in Japanese when asked", () => {
    const marker = { stepId: "step-03", source: "case", text: "Add the item to the cart" };
    expect(renderStepComment(marker)).toBe("// step 3: Add the item to the cart");
    expect(renderStepComment(marker, true)).toBe("// 3. Add the item to the cart");
  });

  it("renders a cleanup step's cited form in English, and in Japanese when asked", () => {
    const marker = { stepId: "cleanup-01", source: "cleanup", text: "Delete the item" };
    expect(renderStepComment(marker)).toBe("// cleanup 1: Delete the item");
    expect(renderStepComment(marker, true)).toBe("// 後処理 1. Delete the item");
  });

  it("parses each cited form back to its step id", () => {
    expect(parseStepComment("// step 3: Add the item to the cart")).toBe("step-03");
    expect(parseStepComment("// 3. Add the item to the cart")).toBe("step-03");
    expect(parseStepComment("// cleanup 1: Delete the item")).toBe("cleanup-01");
    expect(parseStepComment("// 後処理 1. Delete the item")).toBe("cleanup-01");
  });

  it("falls back to the identifier form when a case step has no text", () => {
    const marker = { stepId: "step-03", source: "case" };
    expect(renderStepComment(marker)).toBe("// step: step-03 [case]");
  });

  it("parses a line that is not a step comment to null", () => {
    expect(parseStepComment("// just a note, not a step marker")).toBeNull();
  });

  it("uses only the first line of a multi-line step text", () => {
    const marker = { stepId: "step-02", source: "case", text: "First line\nSecond line" };
    expect(renderStepComment(marker)).toBe("// step 2: First line");
  });
});
