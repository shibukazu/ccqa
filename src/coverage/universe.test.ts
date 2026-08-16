import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { enumerateUniverse } from "./universe.ts";

const dirs: string[] = [];

function scaffold(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ccqa-universe-"));
  dirs.push(root);
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "// x\n");
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("enumerateUniverse", () => {
  it("collects source files under the include dirs, sorted, root-relative", async () => {
    const root = scaffold([
      "src/a.ts",
      "src/deep/b.tsx",
      "src/deep/c.mjs",
      "packages/ui/x.ts",
      "outside/skip.ts",
      "src/readme.md",
      "src/styles.css",
    ]);
    const universe = await enumerateUniverse(root, ["src", "packages"], () => {});
    expect(universe).toEqual({
      include: ["src", "packages"],
      files: ["packages/ui/x.ts", "src/a.ts", "src/deep/b.tsx", "src/deep/c.mjs"],
    });
  });

  it("skips vendored and generated directories, and dot-directories wholesale", async () => {
    const root = scaffold([
      "src/keep.ts",
      "src/node_modules/dep/index.ts",
      "src/dist/out.js",
      "src/.next/chunk.js",
      "src/build/gen.ts",
    ]);
    const universe = await enumerateUniverse(root, ["src"], () => {});
    expect(universe?.files).toEqual(["src/keep.ts"]);
  });

  it("treats a configured include that does not exist as empty, not an error", async () => {
    const root = scaffold(["src/a.ts"]);
    const warnings: string[] = [];
    const universe = await enumerateUniverse(root, ["src", "no-such-dir"], (w) => warnings.push(w));
    expect(universe?.files).toEqual(["src/a.ts"]);
    expect(warnings).toHaveLength(1);
  });

  it("normalises include spellings so one directory cannot enumerate twice", async () => {
    const root = scaffold(["src/a.ts"]);
    const universe = await enumerateUniverse(root, ["src/", "./src", "src"], () => {});
    expect(universe?.files).toEqual(["src/a.ts"]);
  });

  it("omits an empty universe instead of reporting 100% coverage", async () => {
    const root = scaffold(["src/a.ts"]);
    const warnings: string[] = [];
    const universe = await enumerateUniverse(root, ["no-such-dir"], (w) => warnings.push(w));
    expect(universe).toBeUndefined();
    expect(warnings.at(-1)).toContain("matched no files");
  });
});
