import { describe, expect, test } from "vitest";
import { DriftReplySchema, driftSeverity } from "./types.ts";

describe("driftSeverity", () => {
  test("TEST_DRIFT and SPEC_CHANGE hold the gate shut", () => {
    expect(driftSeverity("TEST_DRIFT")).toBe("error");
    expect(driftSeverity("SPEC_CHANGE")).toBe("error");
  });

  test("PRODUCT_BUG, ENVIRONMENT and UNKNOWN are reported without blocking", () => {
    expect(driftSeverity("PRODUCT_BUG")).toBe("warn");
    expect(driftSeverity("ENVIRONMENT")).toBe("warn");
    expect(driftSeverity("UNKNOWN")).toBe("warn");
  });
});

describe("DriftReplySchema", () => {
  const finding = {
    label: "TEST_DRIFT",
    confidence: 0.9,
    surface: "generated",
    headline: "the add button is addressed by a label the source no longer renders",
    recommendation: "re-record the case",
    reasoning: "the source renders Add; the test asks for Create",
    evidence: [{ file: "src/todo-list.ts:22", detail: "the button reads Add" }],
  };

  // Measured: the same case parsed on one run and failed on the next, twice,
  // and a usable verdict was reported as an errored audit.
  test("keeps a verdict whose specChangeKind is not one of the two values", () => {
    const parsed = DriftReplySchema.parse({ drift: { ...finding, specChangeKind: "NONE" } });
    expect(parsed.drift?.label).toBe("TEST_DRIFT");
    expect(parsed.drift?.specChangeKind).toBeUndefined();
  });

  test("keeps the field when it is one of them", () => {
    const parsed = DriftReplySchema.parse({
      drift: { ...finding, label: "SPEC_CHANGE", specChangeKind: "FEATURE_REMOVED" },
    });
    expect(parsed.drift?.specChangeKind).toBe("FEATURE_REMOVED");
  });

  // Only that one field is forgiven: a reply missing a headline is not a
  // verdict with a gap, it is a reply that did not answer.
  test("still rejects a reply that is missing what a finding is made of", () => {
    const { headline: _gone, ...without } = finding;
    expect(() => DriftReplySchema.parse({ drift: without })).toThrow();
  });

  test("no drift is still no drift", () => {
    expect(DriftReplySchema.parse({ drift: null }).drift).toBeNull();
  });
});
