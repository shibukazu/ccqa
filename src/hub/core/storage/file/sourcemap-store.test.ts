import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileSourceMapStore } from "./sourcemap-store.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (b: Uint8Array | null): string | null => (b === null ? null : new TextDecoder().decode(b));

describe("source map store", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-sourcemap-store-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("serves a map back under the asset path it was stored with", async () => {
    const store = createFileSourceMapStore(dataDir);
    await store.put("web", "abc123", "_next/static/chunks/main.js.map", bytes(`{"version":3}`));
    expect(text(await store.read("web", "abc123", "_next/static/chunks/main.js.map"))).toBe(`{"version":3}`);
  });

  test("keeps commits apart, so a stale map is never served for a new deploy", async () => {
    const store = createFileSourceMapStore(dataDir);
    await store.put("web", "old", "chunks/a.js.map", bytes("previous"));
    await store.put("web", "new", "chunks/a.js.map", bytes("current"));
    expect(text(await store.read("web", "old", "chunks/a.js.map"))).toBe("previous");
    expect(text(await store.read("web", "new", "chunks/a.js.map"))).toBe("current");
  });

  test("answers null for a commit that pushed nothing", async () => {
    const store = createFileSourceMapStore(dataDir);
    expect(await store.read("web", "never-pushed", "chunks/a.js.map")).toBeNull();
    expect(await store.list("web", "never-pushed")).toEqual([]);
  });

  test("lists what a commit stored", async () => {
    const store = createFileSourceMapStore(dataDir);
    await store.put("web", "abc", "chunks/a.js.map", bytes("a"));
    await store.put("web", "abc", "chunks/nested/b.js.map", bytes("b"));
    expect((await store.list("web", "abc")).sort()).toEqual(["chunks/a.js.map", "chunks/nested/b.js.map"]);
  });

  test("lists commits newest first, so retention drops the oldest", async () => {
    const store = createFileSourceMapStore(dataDir);
    await store.put("web", "first", "a.js.map", bytes("1"));
    await new Promise((r) => setTimeout(r, 12));
    await store.put("web", "second", "a.js.map", bytes("2"));
    expect(await store.listCommits("web")).toEqual(["second", "first"]);
  });

  test("delete removes one commit and leaves the others", async () => {
    const store = createFileSourceMapStore(dataDir);
    await store.put("web", "keep", "a.js.map", bytes("keep"));
    await store.put("web", "drop", "a.js.map", bytes("drop"));
    await store.delete("web", "drop");
    expect(await store.read("web", "drop", "a.js.map")).toBeNull();
    expect(text(await store.read("web", "keep", "a.js.map"))).toBe("keep");
  });

  test("refuses an asset path that climbs out of the commit's directory", async () => {
    const store = createFileSourceMapStore(dataDir);
    await expect(store.put("web", "abc", "../escape.map", bytes("x"))).rejects.toThrow(/invalid source map path/);
    await expect(store.read("web", "abc", "chunks/../../escape.map")).rejects.toThrow(/invalid source map path/);
  });
});
