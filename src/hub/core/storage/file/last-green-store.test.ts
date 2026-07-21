import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileLastGreenStore } from "./last-green-store.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccqa-lg-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("file last-green store", () => {
  test("merge only advances: an older run cannot move a baseline backwards", async () => {
    const store = createFileLastGreenStore(dir);
    await store.merge("p", "default", "main", {
      "f/s": { gitHead: "new", runId: "r2", at: "2026-07-22T00:00:00Z" },
    });
    await store.merge("p", "default", "main", {
      "f/s": { gitHead: "old", runId: "r1", at: "2026-07-21T00:00:00Z" },
      "f/other": { gitHead: "old", runId: "r1", at: "2026-07-21T00:00:00Z" },
    });
    const entries = await store.get("p", "default", "main");
    expect(entries["f/s"]?.gitHead).toBe("new"); // late-arriving older run ignored
    expect(entries["f/other"]?.gitHead).toBe("old"); // new key still lands
  });

  test("branch names with slashes map to distinct flat files", async () => {
    const store = createFileLastGreenStore(dir);
    await store.merge("p", "default", "feat/x", {
      "f/s": { gitHead: "a", runId: "r", at: "t" },
    });
    expect(await store.get("p", "default", "feat/x")).toHaveProperty("f/s");
    expect(await store.get("p", "default", "feat")).toEqual({});
    expect(await store.get("p", "default", "x")).toEqual({});
  });
});
