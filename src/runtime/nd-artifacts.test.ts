import { describe, test, expect } from "vitest";
import { buildRunId, stepArtifactPaths } from "./nd-artifacts.ts";

describe("buildRunId", () => {
  test("returns a filename-safe ISO8601 stamp", () => {
    const id = buildRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  test("two consecutive ids sort lexicographically by time", () => {
    const a = buildRunId();
    const b = buildRunId();
    expect(a <= b).toBe(true);
  });
});

describe("stepArtifactPaths", () => {
  test("returns before / after / log paths under <runDir>/steps", () => {
    const p = stepArtifactPaths("/tmp/runs/abc", "step-01");
    expect(p.beforePng).toBe("/tmp/runs/abc/steps/step-01.before.png");
    expect(p.afterPng).toBe("/tmp/runs/abc/steps/step-01.after.png");
    expect(p.logTxt).toBe("/tmp/runs/abc/steps/step-01.log.txt");
  });

  test("preserves the stepId verbatim", () => {
    const p = stepArtifactPaths("/r", "step-12-login");
    expect(p.beforePng.endsWith("step-12-login.before.png")).toBe(true);
  });
});
