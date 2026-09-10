import { describe, expect, test } from "vitest";
import { driftSeverity } from "./types.ts";

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
