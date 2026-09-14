import { describe, expect, test } from "vitest";
import { injectedCallGaps, type InjectedCallSpec } from "./index.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";

const markers: StepMarker[] = [
  { actionIndex: 0, stepId: "step-01", source: "case", text: "Open the list" },
  { actionIndex: 2, stepId: "cleanup-01", source: "cleanup", text: "Delete the item" },
];

const spec: InjectedCallSpec = {
  markers,
  stepEvidence: true,
  judgements: [],
  header: "",
  titleSuffix: "",
};

/** What the emitter writes, and what a rewrite pass must hand back unchanged. */
const EMITTED = `
  // step 1: Open the list
  await ccqaStepBefore(page, "step-01", "case");
  await page.goto("/list");
  await ccqaStepAfter(page, "step-01", "case");

  // cleanup 1: Delete the item
  await ccqaStepBefore(page, "cleanup-01", "cleanup");
  await page.getByRole("button", { name: "Delete" }).click();
  await ccqaStepAfter(page, "cleanup-01", "cleanup");
`;

describe("injectedCallGaps", () => {
  test("says nothing about what the emitter wrote", () => {
    expect(injectedCallGaps(EMITTED, spec)).toEqual([]);
  });

  /**
   * The shape a fix pass actually escaped into: `// step-01:` instead of
   * `// step 1:`. Nothing breaks at run time, which is why nothing else
   * noticed — but the evidence table and the spec review read the comment back
   * to attribute assertions, so both then reported every step as deciding
   * nothing, and the one true finding was buried under the false ones.
   */
  test("catches a step comment a rewrite reshaped", () => {
    const reshaped = EMITTED.replace("// step 1: Open the list", "// step-01: Open the list");
    const gaps = injectedCallGaps(reshaped, spec);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("step-01");
    expect(gaps[0]).toContain("attribute assertions");
  });

  // The cleanup's boundary is emitted the same way and read back the same way.
  test("holds the cleanup's comment to the same rule", () => {
    const dropped = EMITTED.replace("// cleanup 1: Delete the item\n", "");
    expect(injectedCallGaps(dropped, spec).join(" ")).toContain("cleanup-01");
  });

  // A project with step evidence off gets no calls emitted, so demanding them
  // would report every step of a correctly generated test.
  test("does not ask for evidence calls a project turned off", () => {
    const comments = EMITTED.split("\n")
      .filter((l) => !l.includes("ccqaStep"))
      .join("\n");
    expect(injectedCallGaps(comments, { ...spec, stepEvidence: false })).toEqual([]);
  });
});
