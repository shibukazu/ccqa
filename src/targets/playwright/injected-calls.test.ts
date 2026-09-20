import { describe, expect, test } from "vitest";
import { injectedCallGaps, type InjectedCallSpec } from "./index.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";

const markers: StepMarker[] = [
  { actionIndex: 0, stepId: "step-01", source: "case", text: "Open the list" },
  { actionIndex: 2, stepId: "cleanup-01", source: "cleanup", text: "Delete the item" },
];

const spec: InjectedCallSpec = {
  markers,
  judgements: [],
  header: "",
  titleSuffix: "",
};

/** What the emitter writes, and what a rewrite pass must hand back unchanged. */
const EMITTED = `
  await test.step("step 1: Open the list", async () => {
    await page.goto("/list");
  });

  await test.step("cleanup 1: Delete the item", async () => {
    await page.getByRole("button", { name: "Delete" }).click();
  });
`;

describe("injectedCallGaps", () => {
  test("says nothing about what the emitter wrote", () => {
    expect(injectedCallGaps(EMITTED, spec)).toEqual([]);
  });

  /**
   * The shape a fix pass actually escaped into: `step-01:` instead of
   * `step 1:`. Nothing breaks at run time, which is why nothing else
   * noticed — but the evidence table and the spec review read the title back
   * to attribute assertions, so both then reported every step as deciding
   * nothing, and the one true finding was buried under the false ones.
   */
  test("catches a step title a rewrite reshaped", () => {
    const reshaped = EMITTED.replace(
      `test.step("step 1: Open the list"`,
      `test.step("step-01: Open the list"`,
    );
    const gaps = injectedCallGaps(reshaped, spec);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("step-01");
    expect(gaps[0]).toContain("attribute assertions");
  });

  // The cleanup's boundary is opened the same way and read back the same way.
  test("holds the cleanup's block to the same rule", () => {
    const dropped = EMITTED.replace(`await test.step("cleanup 1: Delete the item", async () => {\n`, "");
    expect(injectedCallGaps(dropped, spec).join(" ")).toContain("cleanup-01");
  });

  /**
   * What a regeneration actually produced: the rewrite pass read the spec an
   * older ccqa had left at the same path and copied it — capture calls, step
   * comments and all. It type-checked, it ran, and every other gate passed it,
   * so nothing said a word. Both halves of that shape are refused here.
   */
  test("refuses a rewrite that copied an older spec's shape", () => {
    const legacy = `
      import { ccqaStepBefore, ccqaStepAfter } from "ccqa/step-evidence";

      // step 1: Open the list
      await ccqaStepBefore(page, "step-01", "case");
      await page.goto("/list");
      await ccqaStepAfter(page, "step-01", "case");

      // cleanup 1: Delete the item
      await page.getByRole("button", { name: "Delete" }).click();
    `;
    const gaps = injectedCallGaps(legacy, spec).join(" ");
    expect(gaps).toContain("ccqa/step-evidence");
    expect(gaps).toContain("must not load ccqa at run time");
    // The comment form still attributes assertions, so only the narrower
    // question catches it: no step opened a `test.step` block.
    expect(gaps).toContain("step-01");
    expect(gaps).toContain("cleanup-01");
  });

  // A claim is decided at run time by a model, so a case that states one
  // genuinely depends on the judge — that import is the one ccqa may write.
  test("says nothing about the judge a claim is asserted through", () => {
    const judged = `import { judgeByLlm } from "ccqa/judge";\n${EMITTED}`;
    expect(injectedCallGaps(judged, spec)).toEqual([]);
  });

  // The word appears in specs for reasons that are not a dependency — a
  // project's own directory name, an asserted string. Only a load counts.
  test("does not read a mention of ccqa as an import of it", () => {
    const mentions = `${EMITTED}\n  await expect(page.getByText("ccqa/step-evidence")).toBeVisible();`;
    expect(injectedCallGaps(mentions, spec)).toEqual([]);
  });
});
