import { describe, expect, test } from "vitest";
import { buildDriftSystemPrompt } from "./drift.ts";

const NO_BLOCKS: Parameters<typeof buildDriftSystemPrompt>[0] = [];

describe("buildDriftSystemPrompt — severity policy guardrails", () => {
  test("declares the spec/source-mismatch decision rule as CRITICAL", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/CRITICAL: spec ↔ source mismatch is ERROR/);
  });

  test("flags a concrete spec/source mismatch with a citation as MUST-be-ERROR (not vague WARN)", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/MUST use ERROR/);
    expect(out).toMatch(/concrete spec\/source mismatch/);
  });

  test("scopes the WARN (vague phrasing) category narrowly — only when the literal target still exists in source", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/paraphrases a string that \*\*still exists\*\*/);
  });

  test("rejects 'vague phrasing' WARN as a safe fallback for actual drift", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/"vague phrasing" WARN is not a safe fallback/);
  });

  test("retains the original `expected asserts a string ... no longer rendered` ERROR rule", () => {
    const out = buildDriftSystemPrompt(NO_BLOCKS);
    expect(out).toMatch(/no longer rendered by the relevant component/);
  });
});
