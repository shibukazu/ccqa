import { describe, test, expect } from "vitest";
import { TestSpecSchema, ActionStepSchema } from "./types.ts";

describe("ActionStepSchema", () => {
  test("accepts a valid action step", () => {
    const result = ActionStepSchema.safeParse({
      instruction: "Go to login page",
      expected: "Login form is visible",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    expect(ActionStepSchema.safeParse({ instruction: "i" }).success).toBe(false);
  });
});

describe("TestSpecSchema", () => {
  test("accepts a minimal YAML-shaped spec", () => {
    const result = TestSpecSchema.safeParse({
      title: "My Test",
      steps: [{ instruction: "open /", expected: "home" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing title", () => {
    expect(
      TestSpecSchema.safeParse({ steps: [{ instruction: "i", expected: "e" }] }).success,
    ).toBe(false);
  });

  test("rejects missing steps", () => {
    expect(TestSpecSchema.safeParse({ title: "x" }).success).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    const result = TestSpecSchema.safeParse({
      title: "x",
      extra: "value",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(result.success).toBe(false);
  });
});
