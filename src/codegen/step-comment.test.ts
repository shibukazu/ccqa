import { describe, expect, it } from "vitest";
import {
  parseStepBlock,
  parseStepComment,
  parseStepLabel,
  renderStepComment,
  stepLines,
} from "./step-comment.ts";

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

  /**
   * Attribution has to read every spec ccqa has ever written, so it takes the
   * comment form too; the generation gate asks the narrower question, because
   * a rewrite that fell back to comments is exactly what it exists to reject.
   */
  it("reads both placements, and recognises only the block as one ccqa would write today", () => {
    const block = `await test.step("step 3: Add the item to the cart", async () => {`;
    expect(parseStepComment(block)).toBe("step-03");
    expect(parseStepBlock(block)).toBe("step-03");
    expect(parseStepComment("// step 3: Add the item to the cart")).toBe("step-03");
    expect(parseStepBlock("// step 3: Add the item to the cart")).toBeNull();
  });

  /**
   * A formatter is free to wrap the call — Prettier treats `test.step` as an
   * ordinary one — and both readers of a boundary walk lines. Unfolded, a
   * wrapped file has no steps in it at all.
   */
  it("folds a wrapped test.step header back onto the line it opens, leaving the body alone", () => {
    const source = [
      "await test.step(",
      `  "step 3: Add the item to the cart",`,
      "  async () => {",
      "    await expect(page.getByText('Cart')).toBeVisible();",
      "  },",
      ");",
    ].join("\n");

    const lines = stepLines(source);

    expect(lines.map(parseStepBlock).filter((id) => id !== null)).toEqual(["step-03"]);
    expect(lines).toContain("    await expect(page.getByText('Cart')).toBeVisible();");
  });

  // The cited form's text is prose, and prose has brackets of its own — only
  // the identifier form names a source in one.
  it("reads the source out of the identifier form, never out of a cited step's text", () => {
    expect(parseStepLabel("step: step-01 [spec]")).toEqual({ stepId: "step-01", source: "spec" });
    expect(parseStepLabel("step 1: click the [Save] button")).toEqual({
      stepId: "step-01",
      source: "case",
    });
    expect(parseStepLabel("後処理 1. Delete the item")).toEqual({
      stepId: "cleanup-01",
      source: "cleanup",
    });
  });

  it("uses only the first line of a multi-line step text", () => {
    const marker = { stepId: "step-02", source: "case", text: "First line\nSecond line" };
    expect(renderStepComment(marker)).toBe("// step 2: First line");
  });
});
