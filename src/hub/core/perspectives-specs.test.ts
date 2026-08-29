import { describe, expect, test } from "vitest";
import { readSpecTargets } from "./perspectives-specs.ts";

describe("readSpecTargets", () => {
  const doc = (spec: Record<string, unknown>) => ({
    features: [{ featureName: "f", specs: [{ specName: "on" }, spec] }],
  });

  test("leaves out a spec the inventory marked disabled", () => {
    expect(readSpecTargets(doc({ specName: "off", disabled: true })).map((t) => t.key)).toEqual([
      "f/on",
    ]);
  });

  // Absent is how every document written before the field looks, and anything
  // but `true` is not the flag being set.
  test("treats anything but true as listed", () => {
    expect(readSpecTargets(doc({ specName: "b" })).map((t) => t.key)).toEqual(["f/on", "f/b"]);
    expect(readSpecTargets(doc({ specName: "b", disabled: false })).map((t) => t.key)).toEqual([
      "f/on",
      "f/b",
    ]);
  });
});
