import { describe, expect, test } from "vitest";
import type { DriftDiagnosis } from "../report/schema.ts";
import { driftResultsToReport } from "./to-report.ts";
import type { SpecResult } from "./types.ts";

function diagnosis(overrides: Partial<DriftDiagnosis> = {}): DriftDiagnosis {
  return {
    label: "TEST_DRIFT",
    confidence: 0.8,
    surface: "spec",
    subDiagnosis: "SELECTOR_DRIFT",
    headline: "step asserts removed copy",
    recommendation: "Update the selector",
    evidence: [],
    reasoning: "",
    ...overrides,
  };
}

function result(overrides: Partial<SpecResult> = {}): SpecResult {
  return {
    target: { featureName: "tasks", specName: "create" },
    ok: true,
    drift: null,
    ...overrides,
  };
}

const meta = {
  threshold: "error" as const,
  git: { head: "abc1234", base: "origin/main" },
};

describe("driftResultsToReport", () => {
  test("clean specs (drift: null) are all passed and top-level kind is drift", () => {
    const report = driftResultsToReport([result(), result({ target: { featureName: "tasks", specName: "complete" } })], meta);
    expect(report.kind).toBe("drift");
    expect(report.results.map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(report.results.map((r) => r.analysis)).toEqual([null, null]);
  });

  test("a TEST_DRIFT/SPEC_CHANGE diagnosis (error severity) fails the spec", () => {
    const report = driftResultsToReport([result({ drift: diagnosis({ label: "SPEC_CHANGE" }) })], meta);
    expect(report.results[0]!.status).toBe("failed");
  });

  test("an UNKNOWN diagnosis (warn severity) passes under --severity error, fails under warn", () => {
    const d = diagnosis({ label: "UNKNOWN" });
    const underError = driftResultsToReport([result({ drift: d })], meta);
    expect(underError.results[0]!.status).toBe("passed");
    const underWarn = driftResultsToReport([result({ drift: d })], { ...meta, threshold: "warn" });
    expect(underWarn.results[0]!.status).toBe("failed");
  });

  test("the diagnosis is carried through as the row's own verdict, in `analysis`", () => {
    const d = diagnosis();
    const report = driftResultsToReport([result({ drift: d })], meta);
    expect(report.results[0]!.analysis).toEqual({ ...d, reasoning: "" });
  });

  test("specChangeKind reaches the row (normalized upstream, at the drift reply's parse boundary)", () => {
    const changed = driftResultsToReport(
      [result({ drift: diagnosis({ label: "SPEC_CHANGE", specChangeKind: "FEATURE_REMOVED" }) })],
      meta,
    );
    expect(changed.results[0]!.analysis!.specChangeKind).toBe("FEATURE_REMOVED");
  });

  test("a spec with a call error is failed regardless of the diagnosis", () => {
    const report = driftResultsToReport([result({ error: "claude call failed" })], meta);
    expect(report.results[0]!.status).toBe("failed");
  });

  test("customPromptVersion and triageUserPromptHash carry the audit's hub guidance provenance", () => {
    const withGuidance = driftResultsToReport([result()], {
      ...meta,
      customPromptVersion: "2026-07-01-c3",
      triageUserPromptHash: "abc123",
    });
    expect(withGuidance.customPromptVersion).toBe("2026-07-01-c3");
    expect(withGuidance.triageUserPromptHash).toBe("abc123");

    // Omitted (not null) when inactive, matching `ccqa run`'s envelope.
    const withoutGuidance = driftResultsToReport([result()], meta);
    expect(withoutGuidance.customPromptVersion).toBeNull();
    expect(withoutGuidance.triageUserPromptHash).toBeUndefined();
  });
});
