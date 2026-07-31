import { describe, test, expect } from "vitest";
import { buildRunId, stepArtifactPaths } from "./live-artifacts.ts";

describe("buildRunId", () => {
  test("returns a filename-safe ISO8601 stamp with a random suffix", () => {
    const id = buildRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
  });

  // The whole point: two specs the pool starts in the same millisecond must
  // not share an id, or a spec that names created content after it collides
  // with its neighbour and each deletes the other's row.
  test("two ids taken back to back differ", () => {
    expect(buildRunId()).not.toBe(buildRunId());
  });

  test("the timestamp leads, so run directories still sort by time", () => {
    const stamp = (id: string) => id.slice(0, id.lastIndexOf("-"));
    expect(stamp(buildRunId()) <= stamp(buildRunId())).toBe(true);
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
