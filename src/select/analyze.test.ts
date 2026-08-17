import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../drift/affected.ts";
import { parseSpecDirPath, rerootChangesForCoverage, selectSpecs } from "./analyze.ts";
import type { CoverageEdges } from "./coverage-edges.ts";
import type { SpecDescription } from "./inventory.ts";

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", ...overrides };
}

function spec(featureName: string, specName: string, includedBlocks: string[] = []): SpecDescription {
  return {
    featureName,
    specName,
    title: "Sample flow",
    steps: ["open the page", "do a thing"],
    includedBlocks,
  };
}

/** Edges keyed `"feature/spec"`, every measurement stamped at the same time. */
function edgesOf(byKey: Record<string, string[]>): CoverageEdges {
  return new Map(
    Object.entries(byKey).map(([key, files]) => [key, { files: new Set(files), measuredAt: 1 }]),
  );
}

const NO_EDGES: CoverageEdges = new Map();

describe("parseSpecDirPath", () => {
  it("extracts <feature>/<spec> from a spec's own directory, else null", () => {
    expect(parseSpecDirPath(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml")).toBe(
      "checkout/purchase-with-card",
    );
    expect(parseSpecDirPath("src/features/checkout/purchase.ts")).toBeNull();
    expect(parseSpecDirPath(".ccqa/blocks/login/spec.yaml")).toBeNull();
  });
});

describe("selectSpecs: mechanical partitioning", () => {
  it("marks a spec whose own directory changed as needed/mechanical; the rest clear with no product change", async () => {
    const specs = [spec("checkout", "purchase-with-card"), spec("checkout", "apply-coupon")];
    const changed = [file(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges: NO_EDGES });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("mechanical");
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
    expect(coupon.source).toBe("mechanical");
  });

  it("marks only specs that include a changed block as needed; specs without it fall to notNeeded", async () => {
    const specs = [
      spec("checkout", "purchase-with-card", ["login"]),
      spec("checkout", "apply-coupon", []),
    ];
    const changed = [file(".ccqa/blocks/login/spec.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges: NO_EDGES });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("mechanical");
    expect(purchase.touchedBy).toEqual([".ccqa/blocks/login/spec.yaml"]);
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
  });

  it("treats an outsideCwd change as a product change even if it looks like a spec path", async () => {
    const specs = [spec("checkout", "purchase-with-card")];
    const changed = [
      file(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml", { outsideCwd: true }),
    ];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges: NO_EDGES });

    // Went to the coverage pass (not mechanically needed) — proven by the
    // missing edge landing as "unknown" rather than the mechanical "needed".
    expect(report.specs[0]!.verdict).toBe("unknown");
    expect(report.specs[0]!.source).toBe("coverage");
  });

  it("drops a .ccqa/ path that is neither a spec nor a block from the evidence", async () => {
    const specs = [spec("checkout", "purchase-with-card")];
    const changed = [file(".ccqa/config.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges: NO_EDGES });

    expect(report.specs[0]!.verdict).toBe("notNeeded");
    expect(report.specs[0]!.source).toBe("mechanical");
  });
});

describe("selectSpecs: coverage judging", () => {
  const specs = [spec("checkout", "purchase-with-card"), spec("checkout", "apply-coupon")];
  const changed = [file("src/features/checkout/page.ts")];

  it("marks a spec needed when the diff intersects its measured reach, naming the intersection", async () => {
    const edges = edgesOf({
      "checkout/purchase-with-card": ["src/features/checkout/page.ts", "src/shared/api.ts"],
      "checkout/apply-coupon": ["src/features/coupon/page.ts"],
    });

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("coverage");
    expect(purchase.touchedBy).toEqual(["src/features/checkout/page.ts"]);
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
    expect(coupon.source).toBe("coverage");
  });

  it("leaves a spec with no measurement unknown — never notNeeded", async () => {
    const edges = edgesOf({ "checkout/apply-coupon": ["src/features/coupon/page.ts"] });

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("unknown");
    expect(purchase.source).toBe("coverage");
    expect(purchase.reason).toContain("no measurement");
  });

  it("degrades every pending spec to unknown when re-rooting drops the whole diff", async () => {
    // The only product change is a sibling package's, and with no git repo to
    // anchor it the re-root drops it. An edge exists, but nothing measurable
    // remains to hold it against — the spec must not be cleared as notNeeded.
    const outsideOnly = [file("packages/lib/src/b.ts", { outsideCwd: true })];
    const edges = edgesOf({ "checkout/purchase-with-card": ["src/features/checkout/page.ts"] });

    const report = await selectSpecs({ changed: outsideOnly, specs, cwd: "/repo", base: "main", head: "HEAD", edges });

    for (const s of report.specs) expect(s.verdict).toBe("unknown");
    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.reason).toContain("outside the measured root");
  });

  it("marks a spec needed off a renamed file's old path, which selection keeps as delete + add", async () => {
    // Selection diffs with rename detection off, so a rename arrives as the
    // old path deleted plus the new path added — and only the old path can
    // match a measurement taken before the rename.
    const renamed = [
      file("src/features/checkout/old-name.ts", { status: "deleted" }),
      file("src/features/checkout/new-name.ts", { status: "added" }),
    ];
    const edges = edgesOf({ "checkout/purchase-with-card": ["src/features/checkout/old-name.ts"] });

    const report = await selectSpecs({ changed: renamed, specs, cwd: "/repo", base: "main", head: "HEAD", edges });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.touchedBy).toEqual(["src/features/checkout/old-name.ts"]);
  });

  it("degrades every undecided spec to unknown when there are no edges at all", async () => {
    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD", edges: NO_EDGES });

    for (const s of report.specs) {
      expect(s.verdict).toBe("unknown");
      expect(s.source).toBe("coverage");
    }
  });

  it("keeps the mechanical verdict for a spec whose own files changed, even when its edge misses the diff", async () => {
    const mixedChanged = [
      file(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml"),
      file("src/features/checkout/page.ts"),
    ];
    // The edge would clear the spec; the mechanical pass must win anyway.
    const edges = edgesOf({
      "checkout/purchase-with-card": ["src/unrelated.ts"],
      "checkout/apply-coupon": ["src/unrelated.ts"],
    });

    const report = await selectSpecs({ changed: mixedChanged, specs, cwd: "/repo", base: "main", head: "HEAD", edges });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("mechanical");
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
    expect(coupon.source).toBe("coverage");
  });

  it("returns specs in inventory order regardless of mechanical/coverage registration order", async () => {
    const mixedSpecs = [
      spec("checkout", "refund"),
      spec("checkout", "purchase-with-card"),
      spec("checkout", "apply-coupon"),
    ];
    const mixedChanged = [
      file(".ccqa/features/checkout/test-cases/apply-coupon/spec.yaml"),
      file("src/features/checkout/page.ts"),
    ];
    const edges = edgesOf({
      "checkout/refund": ["src/features/checkout/page.ts"],
      "checkout/purchase-with-card": ["src/unrelated.ts"],
    });

    const report = await selectSpecs({ changed: mixedChanged, specs: mixedSpecs, cwd: "/repo", base: "main", head: "HEAD", edges });

    expect(report.specs.map((s) => s.specName)).toEqual(["refund", "purchase-with-card", "apply-coupon"]);
    expect(report.specs.map((s) => s.verdict)).toEqual(["needed", "notNeeded", "needed"]);
  });
});

describe("rerootChangesForCoverage", () => {
  it("is the identity when the coverage root is the cwd", () => {
    const out = rerootChangesForCoverage([file("src/a.ts")], {
      cwd: "/repo/apps/web",
      repoRoot: null,
      coverageRoot: "/repo/apps/web",
    });
    expect(out).toEqual([{ original: "src/a.ts", measured: "src/a.ts" }]);
  });

  it("prefixes cwd-relative paths when the coverage root sits above the cwd", () => {
    const out = rerootChangesForCoverage([file("src/a.ts")], {
      cwd: "/repo/apps/web",
      repoRoot: "/repo",
      coverageRoot: "/repo",
    });
    expect(out).toEqual([{ original: "src/a.ts", measured: "apps/web/src/a.ts" }]);
  });

  it("anchors outsideCwd entries at the repo root, and drops them when no repo root resolved", () => {
    const outside = file("packages/lib/src/b.ts", { outsideCwd: true });
    expect(
      rerootChangesForCoverage([outside], {
        cwd: "/repo/apps/web",
        repoRoot: "/repo",
        coverageRoot: "/repo",
      }),
    ).toEqual([{ original: "packages/lib/src/b.ts", measured: "packages/lib/src/b.ts" }]);
    expect(
      rerootChangesForCoverage([outside], {
        cwd: "/repo/apps/web",
        repoRoot: null,
        coverageRoot: "/repo",
      }),
    ).toEqual([]);
  });

  it("drops a file resolving outside the coverage root — it could never intersect an edge", () => {
    const out = rerootChangesForCoverage(
      [file("packages/lib/src/b.ts", { outsideCwd: true }), file("src/a.ts")],
      {
        cwd: "/repo/apps/web",
        repoRoot: "/repo",
        coverageRoot: "/repo/apps/web",
      },
    );
    expect(out).toEqual([{ original: "src/a.ts", measured: "src/a.ts" }]);
  });
});
