import { describe, expect, test } from "vitest";
import { buildFailureAnalysisPrompt, type FailureAnalysisPromptInput } from "./prompt.ts";

const BASE_INPUT: FailureAnalysisPromptInput = {
  specYaml: "title: sample",
  diffPatch: null,
  changedFiles: null,
  baseRef: null,
};

const USER_HEADING = "## Project triage guidance (human-maintained)";
const CUSTOM_HEADING = "## Calibration guidance from human-graded past failures";

describe("buildFailureAnalysisPrompt guidance injection", () => {
  test("neither block renders when no guidance is supplied (backward compatibility)", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    expect(prompt).not.toContain(USER_HEADING);
    expect(prompt).not.toContain(CUSTOM_HEADING);
    expect(prompt).toBe(buildFailureAnalysisPrompt({ ...BASE_INPUT, triageUserPrompt: null, customPrompt: null }));
  });

  test("human triage.user guidance renders before the learned calibration, both before Output", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...BASE_INPUT,
      triageUserPrompt: "Treat copy changes on the settings screen as SPEC_CHANGE.",
      customPrompt: {
        schemaVersion: 1,
        basePromptVersion: "4",
        customPromptVersion: "v1",
        generatedAt: "t",
        guidance: "Prefer PRODUCT_BUG when the DOM is intact.",
      },
    });
    const userAt = prompt.indexOf(USER_HEADING);
    const customAt = prompt.indexOf(CUSTOM_HEADING);
    const outputAt = prompt.indexOf("## Output");
    expect(userAt).toBeGreaterThan(-1);
    expect(customAt).toBeGreaterThan(userAt);
    expect(outputAt).toBeGreaterThan(customAt);
    expect(prompt).toContain("Treat copy changes on the settings screen as SPEC_CHANGE.");
  });
});

describe("buildFailureAnalysisPrompt baseline-aware guidance (v6)", () => {
  const WITH_DIFF: FailureAnalysisPromptInput = {
    ...BASE_INPUT,
    diffPatch: "diff --git a/src/a.ts b/src/a.ts\n+x",
    changedFiles: "M\tsrc/a.ts",
    baseRef: "last-green",
  };

  test("last-green flips the no-in-range-cause lean to UNKNOWN and states the window", () => {
    const prompt = buildFailureAnalysisPrompt({ ...WITH_DIFF, baseSource: "last-green" });
    expect(prompt).toContain("commit where THIS spec last passed");
    expect(prompt).toContain("Do NOT default to PRODUCT_BUG here");
    expect(prompt).not.toContain("lean PRODUCT_BUG");
  });

  test("fixed-ref baselines keep the PR-base framing", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...WITH_DIFF,
      baseRef: "origin/main",
      baseSource: "github-base-ref",
    });
    expect(prompt).toContain("NOT guaranteed to have passed there");
    expect(prompt).toContain("lean PRODUCT_BUG");
  });

  test("range renders in the diff header and the wide-range caution", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...WITH_DIFF,
      baseSource: "last-green",
      range: { commitCount: 12, days: 5 },
    });
    expect(prompt).toContain("spans 12 commits over 5 days");
  });

  test("captured-but-empty-range renders the empty-patch state, not the no-diff state", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...WITH_DIFF,
      diffPatch: "",
      baseSource: "last-green",
    });
    expect(prompt).toContain("No changes in this range");
    expect(prompt).toContain("M\tsrc/a.ts");
    expect(prompt).not.toContain("No diff context is available");
  });
});

describe("buildFailureAnalysisPrompt no-baseline mode (v8)", () => {
  const NO_BASELINE: FailureAnalysisPromptInput = {
    ...BASE_INPUT,
    baselineMissing: "no last-green baseline for this spec on the hub yet",
  };

  test("replaces the diff framing with current-source guidance and states the reason", () => {
    const prompt = buildFailureAnalysisPrompt(NO_BASELINE);
    expect(prompt).toContain("No known-good baseline exists for this spec yet");
    expect(prompt).toContain("no last-green baseline for this spec on the hub yet");
    expect(prompt).toContain("Classify from the failure signature checked against the current source");
    expect(prompt).toContain("practical confidence ceiling");
    // Diff-range machinery must not leak in: no diff tool usage guidance, no range framing.
    expect(prompt).not.toContain("base...HEAD range. The inline patch");
    expect(prompt).not.toContain("commit where THIS spec last passed");
    expect(prompt).not.toContain("No diff context is available");
  });

  test("without baselineMissing the prompt is unchanged (backward compatibility)", () => {
    expect(buildFailureAnalysisPrompt(BASE_INPUT)).toBe(
      buildFailureAnalysisPrompt({ ...BASE_INPUT, baselineMissing: null }),
    );
  });
});

describe("buildFailureAnalysisPrompt four-cause framing (v13)", () => {
  test("offers all four causes and the question that separates a stale test case from a bug", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    for (const label of ["TEST_DRIFT", "SPEC_CHANGE", "PRODUCT_BUG", "ENVIRONMENT", "UNKNOWN"]) {
      expect(prompt).toContain(label);
    }
    // The rejected two-stage design called a product bug SPEC_CHANGE because
    // the spec and the code disagreed. This sentence is what forbids that.
    expect(prompt).toContain("does NOT by itself mean the test case is stale");
    expect(prompt).toContain("is the code's current behavior what the product intends?");
    // No audit runs first, so nothing may be deferred to.
    expect(prompt).not.toContain("Spec↔code drift audit");
    expect(prompt).not.toContain("second stage");
  });

  test("a spec with generated code can be blamed on either surface", () => {
    const prompt = buildFailureAnalysisPrompt({ ...BASE_INPUT, script: "await page.click('Submit');" });
    expect(prompt).toContain("the `generated` surface");
    expect(prompt).toContain("If both are stale, answer `spec`");
  });

  test("with no generated code the only surface offered is `spec`", () => {
    const prompt = buildFailureAnalysisPrompt({ ...BASE_INPUT, liveTranscriptExcerpt: "step 1 failed" });
    expect(prompt).toContain('Answer `"surface": "spec"`');
    expect(prompt).not.toContain("If both are stale, answer `spec`");
  });
});

describe("buildFailureAnalysisPrompt hasGeneratedSurface vs an unreadable script", () => {
  test("a surface that should exist but couldn't be read says so, not that there is none", () => {
    const prompt = buildFailureAnalysisPrompt({ ...BASE_INPUT, hasGeneratedSurface: true, script: "" });
    expect(prompt).toContain("could not be read");
    expect(prompt).not.toContain("this spec has none");
    expect(prompt).not.toContain("There is no generated code for this spec");
  });

  test("without an explicit flag, an empty script still infers no surface (backward compatibility)", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    expect(prompt).toBe(buildFailureAnalysisPrompt({ ...BASE_INPUT, script: "" }));
    expect(prompt).toContain("this spec has none");
    expect(prompt).toContain('Answer `"surface": "spec"`');
  });

  test("hasGeneratedSurface: true with real content behaves as before (surface choice offered)", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...BASE_INPUT,
      hasGeneratedSurface: true,
      script: "await page.click('Submit');",
    });
    expect(prompt).toContain("the `generated` surface");
    expect(prompt).not.toContain("could not be read");
  });
});

describe("buildFailureAnalysisPrompt Available blocks (include: validation)", () => {
  test("renders the project's blocks and the include-validation instruction", () => {
    const prompt = buildFailureAnalysisPrompt({
      ...BASE_INPUT,
      blocks: [{ name: "login", title: "Log in", params: [{ name: "user", required: true, secret: false }] }],
    });
    expect(prompt).toContain("## Available blocks");
    expect(prompt).toContain("`login`");
    expect(prompt).toContain("Confirm the block exists under");
  });

  test("no blocks defined renders the same empty-state text the audit uses", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    expect(prompt).toContain("no blocks defined yet");
  });

  test("SPEC_CHANGE names a removed include block, mirroring the audit", () => {
    const prompt = buildFailureAnalysisPrompt(BASE_INPUT);
    expect(prompt).toContain("an `include:` step points at a block that no longer exists");
  });
});
