import { describe, expect, it } from "vitest";
import type { SelectReport, SpecSelection } from "../select/types.ts";
import { parseAgainstRange, renderPaths } from "./select-specs.ts";

describe("parseAgainstRange", () => {
  it("splits a plain two-dot range", () => {
    expect(parseAgainstRange("main..HEAD")).toEqual({ base: "main", head: "HEAD" });
  });

  it("splits on the FIRST .., so a ref containing dots still parses", () => {
    expect(parseAgainstRange("v1.2.3..HEAD")).toEqual({ base: "v1.2.3", head: "HEAD" });
  });

  it("rejects a value with no ..", () => {
    expect(parseAgainstRange("main")).toBeNull();
  });

  it("rejects three-dot syntax — the first .. split leaves a head starting with .", () => {
    expect(parseAgainstRange("main...HEAD")).toBeNull();
  });

  it("rejects an empty base or an empty head", () => {
    expect(parseAgainstRange("..HEAD")).toBeNull();
    expect(parseAgainstRange("main..")).toBeNull();
  });
});

describe("renderPaths", () => {
  function selection(over: Partial<SpecSelection>): SpecSelection {
    return { featureName: "checkout", specName: "x", verdict: "needed", source: "mechanical", reason: "", testPath: "", ...over };
  }

  function report(specs: SpecSelection[]): SelectReport {
    // uncoveredFiles carries a marker so a test can assert it never leaks into paths output.
    return { base: "a", head: "b", changedFiles: 0, specs, uncoveredFiles: ["should-not-print.ts"] };
  }

  it("prints one deduplicated test path per selected spec, in report order, and drops notNeeded/empty ones", () => {
    const specs = [
      selection({ specName: "a", verdict: "needed", testPath: "features/checkout/a/test.spec.ts" }),
      selection({ specName: "b", verdict: "unknown", testPath: "features/checkout/a/test.spec.ts" }), // duplicate path
      selection({ specName: "c", verdict: "notNeeded", testPath: "features/checkout/c/test.spec.ts" }), // not selected
      selection({ specName: "d", verdict: "needed", testPath: "" }), // target unresolved
    ];

    expect(renderPaths(report(specs))).toBe("features/checkout/a/test.spec.ts\n");
  });

  it("never includes uncoveredFiles", () => {
    const specs = [selection({ testPath: "features/checkout/a/test.spec.ts" })];

    expect(renderPaths(report(specs))).not.toContain("should-not-print");
  });

  it("is empty when nothing selected has a resolvable test path", () => {
    expect(renderPaths(report([]))).toBe("");
  });
});
