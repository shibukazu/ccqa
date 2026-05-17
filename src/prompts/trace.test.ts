import { describe, expect, it } from "vitest";
import { buildTraceSystemPrompt } from "./trace.ts";

const baseSteps = [
  { id: "step-01", source: "login", instruction: "open https://idp/", expected: "form visible" },
  { id: "step-02", source: "spec", instruction: "click foo", expected: "bar visible" },
];

describe("buildTraceSystemPrompt", () => {
  it("includes the RELATED_PATHS instruction", () => {
    const out = buildTraceSystemPrompt({ title: "demo", steps: baseSteps });
    expect(out).toContain("RELATED_PATHS_BEGIN");
  });

  it("renders each step with its source tag (block name or 'spec') in the heading", () => {
    const out = buildTraceSystemPrompt({ title: "demo", steps: baseSteps });
    expect(out).toContain("### step-01 [login]");
    expect(out).toContain("### step-02 [spec]");
  });

  it("tells Claude to only emit AB_ACTION for the call that finally succeeded", () => {
    const out = buildTraceSystemPrompt({ title: "demo", steps: baseSteps });
    expect(out).toContain("record only successful actions");
    expect(out).toContain("working selector only");
  });

  it("forces selector-based assertions to be verified via `agent-browser wait` before recording", () => {
    const out = buildTraceSystemPrompt({ title: "demo", steps: baseSteps });
    expect(out).toMatch(/MUST-VERIFY rule/);
    expect(out).toContain("accessibility tree");
    expect(out).toContain("DROP the assertion");
    expect(out).toContain('wait "<selector>" --timeout 3000');
  });

  it("also requires text_visible to be verified via `wait --text` and warns about the alt/aria-label trap", () => {
    const out = buildTraceSystemPrompt({ title: "demo", steps: baseSteps });
    expect(out).toContain('wait --text "<text>" --timeout 3000');
    // Structural cues that survive prose rewrites — these label the two
    // accessibility-tree-vs-DOM traps Claude must distinguish.
    expect(out).toMatch(/Text trap/);
    expect(out).toMatch(/Selector trap/);
    // The alt-text gotcha example must be enumerated so Claude pattern-matches.
    expect(out).toMatch(/alt[\s=]/i);
    expect(out).toMatch(/text[- ]node/i);
    // url_contains stays exempt — it has nothing to do with DOM/AT matching.
    expect(out).toMatch(/url_contains.*exempt/);
  });
});
