import { describe, test, expect } from "vitest";
import {
  buildLiveSystemPromptPrefix,
  buildLiveSystemPromptStepSection,
  buildLiveUserPrompt,
  generateLiveSessionName,
} from "./live.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";

// Fully synthetic fixture — no product-specific vocabulary. We use opaque
// placeholders so the test stays decoupled from any consuming codebase.
const SAMPLE_TITLE = "Spec Title Placeholder";
const STEPS: ExpandedActionStep[] = [
  { id: "step-01", source: "block-a", instruction: "INSTRUCTION_A", expected: "EXPECTED_A" },
  { id: "step-02", source: "block-a", instruction: "INSTRUCTION_B", expected: "EXPECTED_B" },
  { id: "step-03", source: "spec", instruction: "INSTRUCTION_C", expected: "EXPECTED_C" },
];

describe("buildLiveSystemPromptPrefix", () => {
  test("includes the spec title, session name, and STEP_RESULT contract template", () => {
    const p = buildLiveSystemPromptPrefix({
      title: SAMPLE_TITLE,
      allSteps: STEPS,
      sessionName: "ccqa-live-test",
    });
    expect(p).toContain(SAMPLE_TITLE);
    expect(p).toContain("ccqa-live-test");
    expect(p).toContain("STEP_RESULT|<stepId>|pass");
    expect(p).toContain("STEP_RESULT|<stepId>|fail");
  });

  test("renders every step with its source tag", () => {
    const p = buildLiveSystemPromptPrefix({
      title: SAMPLE_TITLE,
      allSteps: STEPS,
      sessionName: "s",
    });
    expect(p).toContain("### step-01 [block-a]");
    expect(p).toContain("### step-02 [block-a]");
    expect(p).toContain("### step-03 [spec]");
  });

  test("explicitly states agent-browser constraints are relaxed", () => {
    const p = buildLiveSystemPromptPrefix({
      title: SAMPLE_TITLE,
      allSteps: STEPS,
      sessionName: "s",
    });
    expect(p).toMatch(/any selector form is allowed/i);
    expect(p).toMatch(/no replay contract/i);
  });

  test("renders only input-derived dynamic content (no hostnames, brand names, accounts)", () => {
    // Guardrail: every domain-flavoured substring in the prompt prefix must
    // come from `input` (title / step.instruction / step.expected /
    // sessionName). The check is structural — we don't enumerate "bad"
    // strings, we assert that the only URL-like / email-like tokens present
    // are ones the test fed in. Project-specific hints belong in
    // `.ccqa/prompts/live.user.md` / `.ccqa/prompts/live.agent.md`, which
    // the caller appends after this prefix.
    const p = buildLiveSystemPromptPrefix({
      title: "TITLE_T",
      allSteps: [
        { id: "step-01", source: "spec", instruction: "INSTR_A", expected: "EXP_A" },
      ],
      sessionName: "SESSION_S",
    });
    // Confirm the input markers showed up (so the prefix isn't broken).
    for (const marker of ["TITLE_T", "INSTR_A", "EXP_A", "SESSION_S"]) {
      expect(p).toContain(marker);
    }
    // URL-like tokens with a TLD beyond the few allowed in agent-browser
    // example fragments must NOT appear (e.g. `example.com` is fine for
    // illustrative `agent-browser open <url>` docs; concrete product hosts
    // are not).
    expect(p).not.toMatch(/https?:\/\/[a-z0-9-]+\.(?!example\.|localhost)[a-z]{2,}/i);
    // No literal email addresses should appear in the static prompt.
    expect(p).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe("buildLiveSystemPromptStepSection", () => {
  test("renders the current step's id, instruction, and expected", () => {
    const s = buildLiveSystemPromptStepSection(STEPS[1]!);
    expect(s).toContain("step-02");
    expect(s).toContain("INSTRUCTION_B");
    expect(s).toContain("EXPECTED_B");
  });
});

describe("buildLiveUserPrompt", () => {
  test("references the stepId so the model knows which step to judge", () => {
    expect(buildLiveUserPrompt(STEPS[1]!)).toContain("step-02");
  });
});

describe("generateLiveSessionName", () => {
  test("returns a filename-safe ccqa-live-* string with a random suffix", () => {
    const s = generateLiveSessionName();
    expect(s).toMatch(/^ccqa-live-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
  });

  test("is unique across rapid calls so parallel specs never share a session", () => {
    // The timestamp is millisecond-precision; two specs starting in the same
    // millisecond under --concurrency must still get distinct sessions.
    const names = new Set(Array.from({ length: 1000 }, () => generateLiveSessionName()));
    expect(names.size).toBe(1000);
  });
});
