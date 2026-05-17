import { describe, test, expect } from "vitest";
import { TestSpecSchema, RouteStepSchema, RouteSchema, ActionStepSchema } from "./types.ts";

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

describe("RouteStepSchema", () => {
  test("accepts valid PASSED status", () => {
    const result = RouteStepSchema.safeParse({
      title: "Login",
      action: "filled form",
      observation: "redirected",
      status: "PASSED",
    });
    expect(result.success).toBe(true);
  });

  test("accepts FAILED and SKIPPED status", () => {
    const base = { title: "t", action: "a", observation: "o" };
    expect(RouteStepSchema.safeParse({ ...base, status: "FAILED" }).success).toBe(true);
    expect(RouteStepSchema.safeParse({ ...base, status: "SKIPPED" }).success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = RouteStepSchema.safeParse({
      title: "t", action: "a", observation: "o", status: "UNKNOWN",
    });
    expect(result.success).toBe(false);
  });

  test("reason field is optional", () => {
    const withReason = RouteStepSchema.safeParse({
      title: "t", action: "a", observation: "o", status: "FAILED", reason: "bug",
    });
    const withoutReason = RouteStepSchema.safeParse({
      title: "t", action: "a", observation: "o", status: "PASSED",
    });
    expect(withReason.success).toBe(true);
    expect(withoutReason.success).toBe(true);
  });
});

describe("RouteSchema", () => {
  test("accepts valid passed/failed status", () => {
    const base = { specName: "check", timestamp: "2026-01-01T00:00:00Z", steps: [] };
    expect(RouteSchema.safeParse({ ...base, status: "passed" }).success).toBe(true);
    expect(RouteSchema.safeParse({ ...base, status: "failed" }).success).toBe(true);
  });

  test("rejects invalid status", () => {
    const result = RouteSchema.safeParse({
      specName: "check", timestamp: "2026-01-01T00:00:00Z", status: "PASSED", steps: [],
    });
    expect(result.success).toBe(false);
  });
});
