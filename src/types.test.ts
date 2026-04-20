import { describe, test, expect } from "vitest";
import { TestStepSchema, TestSpecSchema, RouteStepSchema, RouteSchema } from "./types.ts";

describe("TestStepSchema", () => {
  test("accepts valid step data", () => {
    const result = TestStepSchema.safeParse({
      id: "step-01",
      title: "Login",
      instruction: "Go to login page",
      expected: "Login form is visible",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    expect(TestStepSchema.safeParse({ id: "step-01" }).success).toBe(false);
  });
});

describe("TestSpecSchema", () => {
  test("accepts valid spec with optional prerequisites absent", () => {
    const result = TestSpecSchema.safeParse({
      title: "My Test",
      baseUrl: "http://localhost:3000",
      steps: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid spec with prerequisites", () => {
    const result = TestSpecSchema.safeParse({
      title: "My Test",
      baseUrl: "http://localhost:3000",
      prerequisites: "Must be logged in",
      steps: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing title", () => {
    expect(
      TestSpecSchema.safeParse({ baseUrl: "http://localhost", steps: [] }).success,
    ).toBe(false);
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
