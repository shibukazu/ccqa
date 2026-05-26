import { describe, expect, test } from "vitest";
import { buildPerspectivesSystemPrompt } from "./perspectives.ts";

describe("buildPerspectivesSystemPrompt", () => {
  test("follows the spec's title language by default", () => {
    const out = buildPerspectivesSystemPrompt();
    expect(out).toContain("Same language as the spec's title");
  });

  test("forbids severity and gap analysis", () => {
    const out = buildPerspectivesSystemPrompt();
    expect(out).toMatch(/Do NOT assign severity/);
    expect(out).toMatch(/Do NOT do gap analysis/);
  });
});
