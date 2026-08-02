import { describe, expect, test } from "vitest";
import { emptySpecRow } from "../report/spec-row.ts";
import type { PredictedLabel, ReportSpecResult } from "../report/schema.ts";
import { withSink } from "../cli/logger.ts";
import { rerunExplainedFailures, type ExplainRerunMode, type RerunOutcome } from "./explain-rerun.ts";

function failedRow(spec: string, label: PredictedLabel): ReportSpecResult {
  return {
    ...emptySpecRow({ feature: "demo", spec, title: null, status: "failed" }),
    analysis: {
      label,
      confidence: 0.4,
      headline: "the Submit button did nothing",
      recommendation: "look into it",
      evidence: [{ detail: "the log ends at the click" }],
      reasoning: "the step never completed",
    },
  };
}

/** Rerun `rows`, recording which specs were re-executed and what was logged. */
async function rerun(
  rows: ReportSpecResult[],
  opts: { mode: ExplainRerunMode; maxSpecs?: number; outcome?: RerunOutcome },
): Promise<{ results: ReportSpecResult[]; executed: string[]; log: string }> {
  const executed: string[] = [];
  let out = "";
  const results = await withSink({ write: (text) => (out += text) }, () =>
    rerunExplainedFailures(rows, {
      mode: opts.mode,
      maxSpecs: opts.maxSpecs ?? null,
      execute: async (ref) => {
        executed.push(`${ref.featureName}/${ref.specName}`);
        return opts.outcome ?? "passed";
      },
    }),
  );
  return { results, executed, log: out };
}

describe("which failures are rerun", () => {
  const rows = [
    failedRow("a", "UNKNOWN"),
    failedRow("b", "ENVIRONMENT"),
    failedRow("c", "TEST_DRIFT"),
    failedRow("d", "PRODUCT_BUG"),
    { ...emptySpecRow({ feature: "demo", spec: "e", title: null, status: "passed" }) },
  ];

  test("auto takes the two labels a second attempt settles, and no others", async () => {
    const { executed, results } = await rerun(rows, { mode: "auto" });
    expect(executed).toEqual(["demo/a", "demo/b"]);
    expect(results.map((r) => r.rerun?.outcome)).toEqual([
      "passed",
      "passed",
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("always takes every classified failure, and still no passing spec", async () => {
    const { executed } = await rerun(rows, { mode: "always" });
    expect(executed).toEqual(["demo/a", "demo/b", "demo/c", "demo/d"]);
  });
});

describe("what a rerun does to the row", () => {
  test("a second attempt that passes labels the row ENVIRONMENT — and leaves it failed", async () => {
    const { results } = await rerun([failedRow("a", "UNKNOWN")], { mode: "auto", outcome: "passed" });
    const row = results[0]!;
    expect(row.status).toBe("failed");
    expect(row.analysis?.label).toBe("ENVIRONMENT");
    expect(row.rerun).toEqual({ outcome: "passed" });
    expect(row.analysis?.evidence.at(-1)?.detail).toMatch(/not reproducible/);
  });

  test("a second attempt that fails keeps the label and records that it reproduced", async () => {
    const { results } = await rerun([failedRow("a", "UNKNOWN")], { mode: "auto", outcome: "failed" });
    const row = results[0]!;
    expect(row.analysis?.label).toBe("UNKNOWN");
    expect(row.rerun).toEqual({ outcome: "failed" });
    expect(row.analysis?.evidence.at(-1)?.detail).toMatch(/is reproducible/);
  });
});

describe("the cap", () => {
  test("stops after N and names the specs it did not rerun", async () => {
    const rows = ["a", "b", "c"].map((s) => failedRow(s, "UNKNOWN"));
    const { executed, results, log } = await rerun(rows, { mode: "auto", maxSpecs: 2 });
    expect(executed).toEqual(["demo/a", "demo/b"]);
    expect(results[2]?.rerun).toBeUndefined();
    expect(log).toContain("demo/c");
    expect(log).toMatch(/--on-fail-explain-rerun-max-specs 2 reached/);
  });
});
