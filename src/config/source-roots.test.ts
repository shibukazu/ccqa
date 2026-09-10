import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceRoots } from "./source-roots.ts";

let cwd: string;
let outside: string;

// realpath: on macOS the tmpdir lives behind a /var → /private/var symlink,
// and resolveSourceRoots returns real paths — keep both sides comparable.
async function makeDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe("resolveSourceRoots", () => {
  it("resolves a relative root against cwd", async () => {
    cwd = await makeDir("ccqa-source-roots-");
    await mkdir(join(cwd, "app/src"), { recursive: true });

    const [root] = await resolveSourceRoots(cwd, ["app/src"]);
    expect(root).toEqual({ configured: "app/src", abs: join(cwd, "app/src") });
  });

  it("accepts an absolute root outside cwd", async () => {
    cwd = await makeDir("ccqa-source-roots-");
    outside = await makeDir("ccqa-source-roots-outside-");

    const [root] = await resolveSourceRoots(cwd, [outside]);
    expect(root).toEqual({ configured: outside, abs: outside });
  });

  it("resolves a symlinked root to its real path", async () => {
    cwd = await makeDir("ccqa-source-roots-");
    outside = await makeDir("ccqa-source-roots-outside-");
    await symlink(outside, join(cwd, "app-link"));

    const [root] = await resolveSourceRoots(cwd, ["app-link"]);
    expect(root).toEqual({ configured: "app-link", abs: outside });
  });

  it("throws, naming the path, for a missing root and for a root that is a file", async () => {
    cwd = await makeDir("ccqa-source-roots-");
    await writeFile(join(cwd, "notadir"), "x", "utf8");

    await expect(resolveSourceRoots(cwd, ["missing"])).rejects.toThrow(/"missing" is not a directory/);
    await expect(resolveSourceRoots(cwd, ["notadir"])).rejects.toThrow(/"notadir" is not a directory/);
  });
});
