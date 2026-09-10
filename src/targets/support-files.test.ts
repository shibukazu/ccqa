import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSupportFiles } from "./support-files.ts";

/**
 * A neutral fixture repo: a test importing a page object, which imports a
 * shared constant through a tsconfig alias, which imports a package.
 */
describe("collectSupportFiles", () => {
  let cwd: string;

  const write = async (rel: string, body: string): Promise<string> => {
    const path = join(cwd, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, "utf8");
    return path;
  };

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-support-files-"));
    await write(
      "tsconfig.json",
      // Comments and a trailing comma: tsconfig.json is JSONC in the wild.
      `{
  // aliases
  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["e2e/shared/*"] } },
}`,
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("follows relative and aliased imports, and stops at packages", async () => {
    const test = await write(
      "e2e/specs/todo.spec.ts",
      `import { test } from "@playwright/test";
import { TodoPage } from "../pages/todo.js";
`,
    );
    const page = await write(
      "e2e/pages/todo.ts",
      `import { LABELS } from "@shared/labels";
export class TodoPage {}
`,
    );
    const labels = await write("e2e/shared/labels.ts", `export const LABELS = { submit: "Submit" };`);

    expect(await collectSupportFiles(test, cwd)).toEqual([
      { abs: page, from: test },
      { abs: labels, from: page },
    ]);
  });

  it("finds aliases declared in a config the project extends", async () => {
    await write(
      "tsconfig.json",
      `{ "extends": "./tsconfig.base", "compilerOptions": { "strict": true } }`,
    );
    await write(
      "tsconfig.base.json",
      `{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["e2e/shared/*"] } } }`,
    );
    const test = await write("e2e/specs/todo.spec.ts", `import { LABELS } from "@shared/labels";`);
    const labels = await write("e2e/shared/labels.ts", `export const LABELS = {};`);

    expect(await collectSupportFiles(test, cwd)).toEqual([{ abs: labels, from: test }]);
  });

  it("stops at the depth limit", async () => {
    const test = await write("e2e/specs/todo.spec.ts", `import "../pages/todo.ts";`);
    const page = await write("e2e/pages/todo.ts", `import "./deep.ts";`);
    await write("e2e/pages/deep.ts", `export const x = 1;`);

    expect(await collectSupportFiles(test, cwd, { maxDepth: 1 })).toEqual([{ abs: page, from: test }]);
  });

  it("names `from` as the importer that reached each file, not the entry", async () => {
    const entry = await write("e2e/specs/entry.spec.ts", `import "../a.ts";\n`);
    const a = await write("e2e/a.ts", `import "./b.ts";\n`);
    const b = await write("e2e/b.ts", `export const b = 1;\n`);

    expect(await collectSupportFiles(entry, cwd)).toEqual([
      { abs: a, from: entry },
      { abs: b, from: a },
    ]);
  });
});
