import { describe, expect, test } from "vitest";
import { buildAgentUpdateSystemPrompt } from "./agent-update.ts";

describe("buildAgentUpdateSystemPrompt", () => {
  test("live mode learns cross-spec rules: forbids step-id and snapshot-ref anchoring, bans generic filler", () => {
    const prompt = buildAgentUpdateSystemPrompt({
      mode: "live",
      currentAgentMd: null,
      runSummary: "(no live runs executed)",
    });

    // Cross-spec framing, not same-spec.
    expect(prompt).toContain("future live executions across all specs");
    // The two anchoring prohibitions that keep rules reusable across specs.
    expect(prompt).toContain("NEVER anchor a bullet to a step id");
    expect(prompt).toContain("NEVER write a snapshot ref");
    // The three-slot shape and the anti-filler section survive the retarget.
    expect(prompt).toContain("three-slot shape");
    expect(prompt).toContain("### Never write these (generic filler");
    // Guards the fill-vs-inserttext regression: a fill win on a plain login
    // input must not generalize into a default that reaches contenteditable.
    expect(prompt).toContain("Never emit an unconditional or default `fill` text-entry rule");
  });

  test("record mode learns cross-spec too: screen-class anchor, no spec/step-id headings, but selectors verbatim", () => {
    const prompt = buildAgentUpdateSystemPrompt({
      mode: "record",
      currentAgentMd: null,
      runSummary: "(no live runs executed)",
    });

    // Cross-spec framing, keyed on screen/operation kind — not per-spec.
    expect(prompt).toContain("future record traces across all specs");
    // The bug fix: spec/feature-name section headings are forbidden.
    expect(prompt).toContain("NEVER title a section with a spec or feature name");
    expect(prompt).toContain("NEVER anchor a bullet to a step id");
    // Record's identity vs live: selectors stay verbatim (no @eN masking).
    expect(prompt).toContain("stable across runs");
    expect(prompt).toContain("three-slot shape");
    // The churn signal feeds prioritization.
    expect(prompt).toContain("Prioritize the steps with the most dropped attempts");
  });

  test("live and record modes state different optimization goals", () => {
    const liveGoal = buildAgentUpdateSystemPrompt({ mode: "live", currentAgentMd: null, runSummary: "x" });
    const recordGoal = buildAgentUpdateSystemPrompt({ mode: "record", currentAgentMd: null, runSummary: "x" });

    // Both cross-spec, but each names its own surface.
    expect(liveGoal).toContain("future live executions across all specs");
    expect(recordGoal).toContain("future record traces across all specs");
    expect(liveGoal).not.toContain("future record traces across all specs");
    expect(recordGoal).not.toContain("future live executions across all specs");
  });
});
