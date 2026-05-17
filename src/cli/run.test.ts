import { describe, expect, test } from "vitest";
import { selectDriftTargets, type SpecRunSummary } from "./run.ts";

// Minimal subset — `selectDriftTargets` only reads `exitCode` and
// `report.numFailedTests` via `failedSpec`, so the report cast is safe.
function summary(name: string, opts: { passed: boolean }): SpecRunSummary {
  return {
    featureName: "feat",
    specName: name,
    scriptFile: `/tmp/${name}/test.spec.ts`,
    report: {
      numFailedTests: opts.passed ? 0 : 1,
      numPassedTests: opts.passed ? 1 : 0,
      success: opts.passed,
    } as SpecRunSummary["report"],
    exitCode: opts.passed ? 0 : 1,
  };
}

describe("selectDriftTargets", () => {
  const passed = summary("ok-spec", { passed: true });
  const failed = summary("broken-spec", { passed: false });

  test("returns nothing when neither --drift nor --drift-strict is set", () => {
    expect(selectDriftTargets([passed, failed], {})).toEqual([]);
  });

  test("--drift + all passing → empty (drift is a fail-supplement; nothing to explain)", () => {
    expect(selectDriftTargets([passed, passed], { drift: true })).toEqual([]);
  });

  test("--drift + some failing → failing specs only", () => {
    const out = selectDriftTargets([passed, failed], { drift: true });
    expect(out.map((s) => s.specName)).toEqual(["broken-spec"]);
  });

  test("--drift-strict + all passing → ALL specs (audit mode catches stale specs vs source)", () => {
    const out = selectDriftTargets([passed, passed], { driftStrict: true });
    expect(out.map((s) => s.specName)).toEqual(["ok-spec", "ok-spec"]);
  });

  test("--drift-strict + some failing → ALL specs (strict subsumes supplemental mode)", () => {
    const out = selectDriftTargets([passed, failed], { driftStrict: true });
    expect(out.map((s) => s.specName)).toEqual(["ok-spec", "broken-spec"]);
  });

  test("--drift-strict wins when both flags are set", () => {
    const out = selectDriftTargets([passed, failed], { drift: true, driftStrict: true });
    expect(out.map((s) => s.specName)).toEqual(["ok-spec", "broken-spec"]);
  });
});
