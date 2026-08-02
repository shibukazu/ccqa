import { describe, expect, it } from "vitest";
import type { SelectReport } from "../../src/select/types.ts";
import { computeSelectMetrics, scoreSelectCase } from "./score-select.ts";

const report = (rows: Array<[string, "needed" | "notNeeded" | "unknown"]>): SelectReport => ({
  base: "base",
  head: "head",
  changedFiles: 1,
  specs: rows.map(([key, verdict]) => {
    const [featureName, specName] = key.split("/");
    return { featureName: featureName!, specName: specName!, verdict, source: "model" as const, reason: "" };
  }),
});

describe("scoreSelectCase + computeSelectMetrics", () => {
  it("treats unknown as selected — it runs, so precision pays for it", () => {
    const outcomes = scoreSelectCase(
      { "a/hit": "needed" },
      report([
        ["a/hit", "needed"],
        ["a/maybe", "unknown"],
        ["a/cleared", "notNeeded"],
      ]),
    );
    expect(outcomes.map((o) => [o.spec, o.expected, o.selected])).toEqual([
      ["a/hit", "needed", true],
      ["a/maybe", "notNeeded", true],
      ["a/cleared", "notNeeded", false],
    ]);
    const metrics = computeSelectMetrics(outcomes);
    expect(metrics).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      trueNegatives: 1,
      precision: 0.5,
      recall: 1,
    });
    // `unknown` is a safe answer but never the exactly-right one.
    expect(metrics.verdictAccuracy).toBeCloseTo(2 / 3);
  });

  it("catches the miss that matters: a needed spec cleared", () => {
    const metrics = computeSelectMetrics(
      scoreSelectCase({ "a/hit": "needed" }, report([["a/hit", "notNeeded"]])),
    );
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.recall).toBe(0);
    // Nothing selected: no positive claim was made, so precision is not 0.
    expect(metrics.precision).toBeNull();
  });

  it("reports recall as n/a when the case expects nothing", () => {
    const metrics = computeSelectMetrics(
      scoreSelectCase({}, report([["a/quiet", "notNeeded"]])),
    );
    expect(metrics.recall).toBeNull();
    expect(metrics.verdictAccuracy).toBe(1);
  });
});
