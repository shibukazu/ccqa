import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadStorageState,
  mergeStorageStates,
  removeTempStateDir,
  sessionFilePath,
  writeMergedTempState,
  type StorageState,
} from "./session-state.ts";

const state = (cookies: object[], origins: object[]): StorageState =>
  ({ cookies, origins }) as StorageState;

describe("sessionFilePath", () => {
  test("resolves under .ccqa/sessions/<profile>/<name>.json", () => {
    expect(sessionFilePath("admin", "stg", "/repo")).toBe(
      "/repo/.ccqa/sessions/stg/admin.json",
    );
  });

  test("falls back to the default profile bucket", () => {
    expect(sessionFilePath("admin", undefined, "/repo")).toBe(
      "/repo/.ccqa/sessions/default/admin.json",
    );
  });
});

describe("mergeStorageStates", () => {
  test("unions cookies from distinct providers (no collision)", () => {
    const a = state([{ name: "s", domain: "a.example", path: "/" }], []);
    const b = state([{ name: "s", domain: "b.example", path: "/" }], []);
    const merged = mergeStorageStates([a, b]);
    expect(merged.cookies).toHaveLength(2);
  });

  test("later state wins on same (name, domain, path)", () => {
    const a = state([{ name: "s", domain: "a.example", path: "/", value: "old" }], []);
    const b = state([{ name: "s", domain: "a.example", path: "/", value: "new" }], []);
    const merged = mergeStorageStates([a, b]);
    expect(merged.cookies).toHaveLength(1);
    expect(merged.cookies[0]).toMatchObject({ value: "new" });
  });

  test("unions origins by origin string", () => {
    const a = state([], [{ origin: "https://a.example", localStorage: [] }]);
    const b = state([], [{ origin: "https://b.example", localStorage: [] }]);
    const merged = mergeStorageStates([a, b]);
    expect(merged.origins.map((o) => o.origin).sort()).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("loadStorageState", () => {
  test("rejects a file that isn't { cookies, origins }", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-session-test-"));
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ foo: 1 }), "utf8");
    await expect(loadStorageState(bad)).rejects.toThrow(/not a valid agent-browser state file/);
  });

  test("round-trips a valid state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-session-test-"));
    const file = join(dir, "ok.json");
    const s = state([{ name: "s", domain: "a.example", path: "/" }], []);
    await writeFile(file, JSON.stringify(s), "utf8");
    expect(await loadStorageState(file)).toEqual(s);
  });
});

describe("writeMergedTempState", () => {
  test("writes the merged state to a fresh temp file with 0600 permissions", async () => {
    const s = state([{ name: "s", domain: "a.example", path: "/" }], []);
    const path = await writeMergedTempState(s);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(s);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    await removeTempStateDir(path);
  });
});

describe("removeTempStateDir", () => {
  test("removes the temp dir created by writeMergedTempState", async () => {
    const s = state([], []);
    const path = await writeMergedTempState(s);
    await removeTempStateDir(path);
    await expect(stat(dirname(path))).rejects.toThrow();
  });
});
