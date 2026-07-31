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

  test("a generation flow's .agent note is guidance (markdown), not custom-prompt (json)", () => {
    // record.agent/live.agent/playwright.agent/runn.agent are plain prose the
    // model writes, unlike triage.agent/audit.agent below — same kind as
    // their .user counterpart, despite the "agent" name.
    for (const kind of GUIDANCE_KINDS) {
      expect(promptKind(`${kind}.agent`)).toBe("guidance");
      expect(PROMPT_LOCAL_PATHS[`${kind}.agent`]).toMatch(/\.md$/);
    }
  });

  test("the run and the audit each get a .user/.agent pair of their own", () => {
    // Two prompts because they answer two questions: the audit decides whether
    // a spec still describes the code, the run decides why it failed anyway.
    for (const name of ["triage.user", "audit.user"] as const) {
      expect(isPromptName(name)).toBe(true);
      expect(promptKind(name)).toBe("guidance");
    }
    for (const name of ["triage.agent", "audit.agent"] as const) {
      expect(isPromptName(name)).toBe(true);
      expect(promptKind(name)).toBe("custom-prompt");
    }
  });

  test("every prompt name maps to a local path (push/pull never drift)", () => {
    for (const name of PROMPT_NAMES) {
      expect(PROMPT_LOCAL_PATHS[name]).toMatch(/^\.ccqa\/prompts\//);
    }
  });
});
