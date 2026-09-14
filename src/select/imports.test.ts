import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../drift/affected.ts";
import { importSelections, selectByImports, type ProjectChange } from "./imports.ts";
import type { SpecDescription } from "./inventory.ts";

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", ...overrides };
}

function testCase(featureName: string, specName: string, testPath: string): SpecDescription {
  return {
    featureName,
    specName,
    title: "Sample flow",
    steps: ["open the page", "do a thing"],
    includedBlocks: [],
    testPath,
    recordingPath: testPath === "" ? "" : testPath.replace(/\.ts$/, ".ccqa.ir.json"),
    sourcePath: `docs/testcase/${featureName}/${specName}.md`,
  };
}

describe("importSelections", () => {
  const purchase = testCase("checkout", "purchase-with-card", "e2e/specs/purchase.spec.ts");
  const coupon = testCase("checkout", "apply-coupon", "e2e/specs/coupon.spec.ts");
  const live = testCase("checkout", "review-live", "");

  const imports = (entries: Record<string, string[]>, truncated = false) =>
    new Map(
      Object.entries(entries).map(([key, files]) => [key, { files: new Set(files), truncated }]),
    );

  const change = (original: string, abs: string): ProjectChange => ({ original, abs });

  // No entry for the live case — it compiled no test, so it walked nothing.
  const graphs = imports({
    "checkout/purchase-with-card": ["/repo/e2e/specs/purchase.spec.ts", "/repo/e2e/pages/checkout.ts"],
    "checkout/apply-coupon": ["/repo/e2e/specs/coupon.spec.ts", "/repo/e2e/pages/coupon.ts"],
  });

  it("selects only the case whose test imports the changed file, naming it in the reason", () => {
    const selections = importSelections(
      [purchase, coupon],
      [change("e2e/pages/checkout.ts", "/repo/e2e/pages/checkout.ts")],
      graphs,
    );

    expect([...selections.keys()]).toEqual(["checkout/purchase-with-card"]);
    const selected = selections.get("checkout/purchase-with-card")!;
    expect(selected.verdict).toBe("needed");
    expect(selected.source).toBe("mechanical");
    expect(selected.reason).toContain("e2e/pages/checkout.ts");
    expect(selected.touchedBy).toEqual(["e2e/pages/checkout.ts"]);
    expect(selected.testPath).toBe("e2e/specs/purchase.spec.ts");
  });

  it("selects a case whose own compiled test changed, and reports every match", () => {
    const selections = importSelections(
      [purchase],
      [
        change("e2e/specs/purchase.spec.ts", "/repo/e2e/specs/purchase.spec.ts"),
        change("e2e/pages/checkout.ts", "/repo/e2e/pages/checkout.ts"),
      ],
      graphs,
    );

    const selected = selections.get("checkout/purchase-with-card")!;
    expect(selected.reason).toContain("e2e/specs/purchase.spec.ts");
    expect(selected.touchedBy).toEqual(["e2e/specs/purchase.spec.ts", "e2e/pages/checkout.ts"]);
  });

  it("selects nothing for a live case — it compiled no test, so it has no graph to match against", () => {
    const selections = importSelections(
      [live],
      [change("e2e/shared/labels.ts", "/repo/e2e/shared/labels.ts")],
      graphs,
    );

    expect(selections.size).toBe(0);
  });

  it("selects nothing when no changed file is in any case's graph", () => {
    const selections = importSelections(
      [purchase, coupon],
      [change("src/product/checkout.ts", "/repo/src/product/checkout.ts")],
      graphs,
    );

    expect(selections.size).toBe(0);
  });

  it("selects a case whose walk was cut short, even when the change touches nothing it read", () => {
    const selections = importSelections(
      [purchase],
      [change("e2e/shared/labels.ts", "/repo/e2e/shared/labels.ts")],
      imports({ "checkout/purchase-with-card": ["/repo/e2e/specs/purchase.spec.ts"] }, true),
    );

    const selected = selections.get("checkout/purchase-with-card")!;
    expect(selected.verdict).toBe("needed");
    expect(selected.reason).toMatch(/more files than the walk reads/);
    // Nothing it read was touched, so there is no changed path to attribute.
    expect(selected.touchedBy).toBeUndefined();
  });
});

describe("selectByImports", () => {
  // Filtered out before the walk starts (`projectChanges`), so this needs no
  // real tree: the fs-touching two-hop walk itself is already covered by
  // `analyze.test.ts`'s `selectSpecs` fixture.
  it("skips the walk when every change is outside the project", async () => {
    const cases = [testCase("todo", "add-item", "e2e/specs/todo.spec.ts")];
    const outside = [file("packages/lib/src/b.ts", { outsideCwd: true })];

    expect((await selectByImports(cases, outside, "/repo", "/repo")).size).toBe(0);
    // A --repo naming a disjoint checkout re-roots every path out of the tree.
    expect(
      (await selectByImports(cases, [file("e2e/shared/labels.ts")], "/repo", "/other/checkout")).size,
    ).toBe(0);
  });
});
