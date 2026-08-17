import { describe, expect, it } from "vitest";
import type { SelectReport, SpecSelection } from "./types.ts";
import { specsToRun } from "./types.ts";

describe("specsToRun", () => {
  it("keeps needed and unknown, drops notNeeded", () => {
    const specs: SpecSelection[] = [
      { featureName: "checkout", specName: "purchase-with-card", verdict: "needed", source: "mechanical", reason: "" },
      { featureName: "checkout", specName: "apply-coupon", verdict: "notNeeded", source: "mechanical", reason: "" },
      { featureName: "checkout", specName: "refund", verdict: "unknown", source: "coverage", reason: "" },
    ];
    const report: SelectReport = { base: "a", head: "b", changedFiles: 1, specs };

    expect(specsToRun(report).map((s) => s.specName)).toEqual(["purchase-with-card", "refund"]);
  });
});
