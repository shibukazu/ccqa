import { describe, expect, it } from "vitest";
import { reattachStepIds } from "./generate.ts";
import type { TraceAction } from "../types.ts";

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
});
