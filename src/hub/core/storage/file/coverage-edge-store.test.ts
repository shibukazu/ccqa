import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileCoverageEdgeStore } from "./coverage-edge-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "ccqa-edges-"));
  dirs.push(dir);
  return createFileCoverageEdgeStore(dir);
}

describe("coverage-edge store", () => {
  it("merges per spec: a run's entries land, everyone else's survive", async () => {
    const edges = store();
    await edges.merge("demo", { "checkout/a": { files: ["src/b.ts", "src/a.ts"] } }, 1000);
    await edges.merge("demo", { "checkout/b": { files: ["src/c.ts"], runId: "r2" } }, 2000);

    const doc = (await edges.get("demo"))!;
    expect(doc.specs["checkout/a"]).toEqual({ files: ["src/a.ts", "src/b.ts"], measuredAt: 1000 });
    expect(doc.specs["checkout/b"]).toEqual({ files: ["src/c.ts"], measuredAt: 2000, runId: "r2" });
  });

  it("a newer measurement replaces a spec's entry outright", async () => {
    const edges = store();
    await edges.merge("demo", { "checkout/a": { files: ["src/old.ts"] } }, 1000);
    await edges.merge("demo", { "checkout/a": { files: ["src/new.ts"] } }, 2000);

    const doc = (await edges.get("demo"))!;
    expect(doc.specs["checkout/a"]!.files).toEqual(["src/new.ts"]);
    expect(doc.specs["checkout/a"]!.measuredAt).toBe(2000);
  });

  it("concurrent merges both land — the read-modify-write is serialized", async () => {
    const edges = store();
    await Promise.all([
      edges.merge("demo", { "checkout/a": { files: ["src/a.ts"] } }, 1000),
      edges.merge("demo", { "checkout/b": { files: ["src/b.ts"] } }, 1000),
    ]);

    const doc = (await edges.get("demo"))!;
    expect(Object.keys(doc.specs).sort()).toEqual(["checkout/a", "checkout/b"]);
  });

  it("answers null for a project with no ledger", async () => {
    expect(await store().get("demo")).toBeNull();
  });

  it("refuses a present document that does not match the schema instead of resetting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccqa-edges-"));
    dirs.push(dir);
    const edges = createFileCoverageEdgeStore(dir);
    mkdirSync(join(dir, "coverage-edges"), { recursive: true });
    writeFileSync(join(dir, "coverage-edges", "demo.json"), JSON.stringify({ specs: { a: { files: "no" } } }));

    await expect(edges.get("demo")).rejects.toThrow(/does not match/);
    // A merge that read the broken document as empty would discard every
    // other spec's edge; it must reject instead.
    await expect(edges.merge("demo", { "checkout/a": { files: ["src/a.ts"] } }, 1)).rejects.toThrow(
      /does not match/,
    );
  });
});
