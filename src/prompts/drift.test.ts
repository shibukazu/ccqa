import { describe, expect, test } from "vitest";
import { buildDriftSystemPrompt, buildDriftUserPrompt } from "./drift.ts";

const NO_BLOCKS: Parameters<typeof buildDriftSystemPrompt>[0] = [];

describe("buildDriftSystemPrompt", () => {
  test("excludes PRODUCT_BUG and ENVIRONMENT — a static read never observes a run", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/You may not answer PRODUCT_BUG or ENVIRONMENT/);
    expect(out).toMatch(/a static read cannot tell a dropped side effect from a working one/);
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

  test("the output contract is a single JSON block with the diagnosis vocabulary", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/"drift": null/);
    expect(out).toMatch(/"label": "TEST_DRIFT" \| "SPEC_CHANGE" \| "UNKNOWN"/);
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
      specYaml: "title: Sample\nsteps: []",
      generated: [],
      live: false,
      title: "Sample",
    });
    expect(out).toContain("```yaml\ntitle: Sample\nsteps: []\n```");
  });
});
