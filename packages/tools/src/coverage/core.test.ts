import { AsyncLocalStorage } from "node:async_hooks";

import { beforeEach, describe, expect, it } from "vitest";

import { closeBucket, installRuntime, openBucket, record, runInSpec, type CoverageStore } from "./core.ts";

const RUNTIME_KEY = Symbol.for("ccqa.coverage.runtime");

/** installRuntime() is a process-wide singleton; each test needs a clean slate. */
beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
  delete (globalThis as Record<string, unknown>).__ccqaCoverage;
});

function install() {
  return installRuntime(new AsyncLocalStorage<CoverageStore>());
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("record", () => {
  it("does nothing, and does not throw, when no runtime is installed", () => {
    expect(() => record("src/a.ts")).not.toThrow();
  });
});

describe("runInSpec", () => {
  it("attributes a record() made inside the spec's context to its bucket, and one made outside to unattributed", () => {
    const runtime = install();
    runInSpec("run1.spec-a", () => {
      record("src/a.ts");
    });
    record("src/outside.ts");

    expect([...runtime.buckets.get("run1.spec-a")!]).toEqual(["src/a.ts"]);
    expect(runtime.unattributed).toBe(1);
  });

  it("keeps two concurrent specs' buckets separate when their executions interleave", async () => {
    const runtime = install();

    const a = runInSpec("run1.spec-a", async () => {
      record("src/a1.ts");
      await tick();
      record("src/a2.ts");
    });
    const b = runInSpec("run1.spec-b", async () => {
      record("src/b1.ts");
      await tick();
      record("src/b2.ts");
    });
    await Promise.all([a, b]);

    expect([...runtime.buckets.get("run1.spec-a")!].sort()).toEqual(["src/a1.ts", "src/a2.ts"]);
    expect([...runtime.buckets.get("run1.spec-b")!].sort()).toEqual(["src/b1.ts", "src/b2.ts"]);
  });
});

describe("topLevel records", () => {
  it("go to boot, not a spec bucket, and are kept even while no spec is open", () => {
    const runtime = install();
    record("src/module.ts", true);

    expect(runtime.active).toBe(0);
    expect([...runtime.boot]).toEqual(["src/module.ts"]);
  });
});

describe("closeBucket", () => {
  it("brings active back to 0 once the last open bucket closes", () => {
    const runtime = install();
    openBucket(runtime, "run1.spec-a");
    expect(runtime.active).toBe(1);

    closeBucket(runtime, "run1.spec-a");
    expect(runtime.active).toBe(0);
  });
});
