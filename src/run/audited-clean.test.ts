import { describe, expect, test } from "vitest";
import { selectAuditedClean } from "./audited-clean.ts";

const spec = (name: string) => ({ featureName: "f", specName: name });

describe("selectAuditedClean", () => {
  test("a spec nobody audited is dropped, and counted apart from a drifted one", () => {
    // The distinction that matters: both are excluded, but only one of them is
    // a finding. Folding them together would read as "the audit rejected it".
    const picked = selectAuditedClean([spec("clean"), spec("drifted"), spec("new")], {
      clean: new Set(["f/clean"]),
      audited: new Set(["f/clean", "f/drifted"]),
    });
    expect(picked.selected).toEqual([spec("clean")]);
    expect(picked).toMatchObject({ drifted: 1, unaudited: 1 });
  });
});
