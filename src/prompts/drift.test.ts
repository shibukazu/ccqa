import { describe, expect, test } from "vitest";
import { buildDriftSystemPrompt, buildDriftUserPrompt } from "./drift.ts";

const NO_BLOCKS: Parameters<typeof buildDriftSystemPrompt>[0] = [];

describe("buildDriftSystemPrompt", () => {
  test("reports PRODUCT_BUG and ENVIRONMENT as suspicions that never hold the gate shut", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(
      /PRODUCT_BUG and ENVIRONMENT do not: they are reported and the case still runs, because running it is what settles them/,
    );
    expect(out).toMatch(/The first two are the answers that act/);
  });

  test("frames TEST_DRIFT vs SPEC_CHANGE by the action each leads to", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/TEST_DRIFT gets the test re-recorded, SPEC_CHANGE gets a human to rewrite the spec/);
  });

  test("requires a citation before a TEST_DRIFT/SPEC_CHANGE finding is earned", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/A finding needs a citation/);
    expect(out).toMatch(/No drift is a claim, not a default/);
  });

  test("a citation is judged against the control flow guarding it, not its mere existence", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/A citation must apply to the case at hand/);
    expect(out).toMatch(/A comment is not the code/);
    expect(out).toMatch(/SPEC_CHANGE is the more expensive answer/);
  });

  test("the output contract is a single JSON block with the diagnosis vocabulary", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/"drift": null/);
    expect(out).toMatch(/"label": "TEST_DRIFT" \| "SPEC_CHANGE" \| "PRODUCT_BUG" \| "ENVIRONMENT" \| "UNKNOWN"/);
    expect(out).toMatch(/"subDiagnosis": "SELECTOR_DRIFT" \| "OVER_ASSERTION" \| "NONE"/);
    expect(out).toMatch(/"specChangeKind": "FEATURE_REMOVED" \| "BEHAVIOUR_CHANGED"/);
  });

  test("specChangeKind is scoped to SPEC_CHANGE, and omitted rather than guessed", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/set it only when the label is `SPEC_CHANGE`/);
    expect(out).toMatch(/When the evidence does not support "gone", answer `BEHAVIOUR_CHANGED`/);
    expect(out).toMatch(/When neither reading is supported, omit the field/);
  });
});

describe("buildDriftUserPrompt", () => {
  test("embeds the spec's YAML verbatim in a fenced block", () => {
    const out = buildDriftUserPrompt({
      intent: { kind: "spec", path: ".ccqa/features/demo/test-cases/sample/spec.yaml", body: "title: Sample\nsteps: []" },
      generated: [],
      unaudited: [],
      live: false,
      title: "Sample",
    });
    expect(out).toContain("```yaml\ntitle: Sample\nsteps: []\n```");
  });

  test("a spec whose only generated file was too large is not called ungenerated", () => {
    const out = buildDriftUserPrompt({
      intent: { kind: "spec", path: ".ccqa/features/demo/test-cases/sample/spec.yaml", body: "title: Sample\nsteps: []" },
      generated: [],
      unaudited: ["e2e/specs/sample.spec.ts"],
      live: false,
      title: "Sample",
    });
    expect(out).toContain("e2e/specs/sample.spec.ts");
    expect(out).toMatch(/This case IS generated/);
    expect(out).not.toMatch(/has not been generated yet/);
  });
});
