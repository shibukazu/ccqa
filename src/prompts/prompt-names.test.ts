import { describe, expect, test } from "vitest";
import {
  GUIDANCE_KINDS,
  isPromptName,
  PROMPT_LOCAL_PATHS,
  PROMPT_NAMES,
  promptKind,
} from "./prompt-names.ts";

describe("prompt name registry", () => {
  test("every guidance kind has its .user/.agent pair registered", () => {
    for (const kind of GUIDANCE_KINDS) {
      expect(isPromptName(`${kind}.user`)).toBe(true);
      expect(isPromptName(`${kind}.agent`)).toBe(true);
    }
  });

  test("triage.user is a registered guidance prompt without an .agent pair", () => {
    expect(isPromptName("triage.user")).toBe(true);
    expect(promptKind("triage.user")).toBe("guidance");
    // The learned triage overlay still lives under its legacy name.
    expect(isPromptName("triage.agent")).toBe(false);
    expect(promptKind("analysis-custom-prompt")).toBe("custom-prompt");
  });

  test("every prompt name maps to a local path (push/pull never drift)", () => {
    for (const name of PROMPT_NAMES) {
      expect(PROMPT_LOCAL_PATHS[name]).toMatch(/^\.ccqa\/prompts\//);
    }
  });
});
