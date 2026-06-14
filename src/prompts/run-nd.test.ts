import { describe, test, expect } from "vitest";
import {
  buildRunNdSystemPromptPrefix,
  buildRunNdSystemPromptStepSection,
  buildRunNdUserPrompt,
  generateRunNdSessionName,
} from "./run-nd.ts";
import type { ExpandedActionStep } from "../spec/expand.ts";

const STEPS: ExpandedActionStep[] = [
  { id: "step-01", source: "login", instruction: "ログインページにアクセスする", expected: "ログインフォームが表示される" },
  { id: "step-02", source: "login", instruction: "認証情報を入力する", expected: "ログインが成功する" },
  { id: "step-03", source: "spec", instruction: "一覧ページに遷移する", expected: "一覧が表示される" },
];

describe("buildRunNdSystemPromptPrefix", () => {
  test("includes the spec title, session name, and STEP_RESULT contract template", () => {
    const p = buildRunNdSystemPromptPrefix({
      title: "コンテンツ検索",
      allSteps: STEPS,
      sessionName: "ccqa-run-nd-test",
    });
    expect(p).toContain("コンテンツ検索");
    expect(p).toContain("ccqa-run-nd-test");
    expect(p).toContain("STEP_RESULT|<stepId>|pass");
    expect(p).toContain("STEP_RESULT|<stepId>|fail");
  });

  test("renders every step with its source tag", () => {
    const p = buildRunNdSystemPromptPrefix({
      title: "t",
      allSteps: STEPS,
      sessionName: "s",
    });
    expect(p).toContain("### step-01 [login]");
    expect(p).toContain("### step-02 [login]");
    expect(p).toContain("### step-03 [spec]");
  });

  test("explicitly states agent-browser constraints are relaxed", () => {
    const p = buildRunNdSystemPromptPrefix({
      title: "t",
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
    // `.ccqa/prompts/run-nd.user.md`, which the caller appends after this
    // prefix.
    const p = buildRunNdSystemPromptPrefix({
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

describe("buildRunNdSystemPromptStepSection", () => {
  test("renders the current step's id, instruction, and expected", () => {
    const s = buildRunNdSystemPromptStepSection(STEPS[1]!);
    expect(s).toContain("step-02");
    expect(s).toContain("認証情報を入力する");
    expect(s).toContain("ログインが成功する");
  });
});

describe("buildRunNdUserPrompt", () => {
  test("references the stepId so the model knows which step to judge", () => {
    expect(buildRunNdUserPrompt(STEPS[1]!)).toContain("step-02");
  });
});

describe("generateRunNdSessionName", () => {
  test("returns a filename-safe ccqa-run-nd-* string", () => {
    const s = generateRunNdSessionName();
    expect(s).toMatch(/^ccqa-run-nd-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });
});
