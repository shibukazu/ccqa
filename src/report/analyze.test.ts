import { describe, expect, test } from "vitest";
import { normaliseFailureAnalysis } from "./analyze.ts";

describe("normaliseFailureAnalysis", () => {
  test("accepts a well-formed analysis", () => {
    const out = normaliseFailureAnalysis({
      label: "SPEC_CHANGE",
      confidence: 0.8,
      subDiagnosis: "NONE",
      evidence: [{ file: "src/page.tsx (hunk @@ -10,4)", detail: "step's button removed" }],
      reasoning: "the diff deletes the confirm dialog the spec asserts",
    });
    expect(out).toEqual({
      label: "SPEC_CHANGE",
      confidence: 0.8,
      subDiagnosis: "NONE",
      evidence: [{ file: "src/page.tsx (hunk @@ -10,4)", detail: "step's button removed" }],
      reasoning: "the diff deletes the confirm dialog the spec asserts",
    });
  });

  test("rejects an unknown label (caller falls through to the next JSON candidate)", () => {
    expect(normaliseFailureAnalysis({ label: "FLAKY", confidence: 0.9 })).toBeNull();
  });

  test("rejects non-objects", () => {
    expect(normaliseFailureAnalysis(null)).toBeNull();
    expect(normaliseFailureAnalysis("TEST_DRIFT")).toBeNull();
    expect(normaliseFailureAnalysis([1, 2])).toBeNull();
  });

  test("missing optional fields degrade gracefully", () => {
    const out = normaliseFailureAnalysis({ label: "PRODUCT_BUG" });
    expect(out).toEqual({
      label: "PRODUCT_BUG",
      confidence: 0,
      subDiagnosis: "NONE",
      evidence: [],
      reasoning: "",
    });
  });

  test("clamps out-of-range confidence", () => {
    expect(normaliseFailureAnalysis({ label: "UNKNOWN", confidence: 7 })?.confidence).toBe(1);
    expect(normaliseFailureAnalysis({ label: "UNKNOWN", confidence: -1 })?.confidence).toBe(0);
  });

  test("invalid subDiagnosis falls back to NONE", () => {
    const out = normaliseFailureAnalysis({ label: "TEST_DRIFT", subDiagnosis: "WEIRD" });
    expect(out?.subDiagnosis).toBe("NONE");
  });

  test("malformed evidence entries are dropped, valid ones kept", () => {
    const out = normaliseFailureAnalysis({
      label: "TEST_DRIFT",
      evidence: [
        { detail: "kept, log-only" },
        { file: "a.ts:1" }, // no detail → dropped
        "not an object",
        { file: "b.ts:2", detail: "kept, with file" },
      ],
    });
    expect(out?.evidence).toEqual([
      { detail: "kept, log-only" },
      { file: "b.ts:2", detail: "kept, with file" },
    ]);
  });
});
