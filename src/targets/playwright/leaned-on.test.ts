import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leanedOn } from "./index.ts";

let cwd: string;

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function makeProject(files: Record<string, string>): Promise<string> {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-leaned-on-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return cwd;
}

describe("leanedOn", () => {
  // The half nobody re-reads: a page object written under whatever rules the
  // project had then, imported verbatim ever since, and never opened again.
  it("names the support files the test imports but did not write", async () => {
    await makeProject({
      "e2e/add-item.spec.ts": 'import { ListPage } from "./pages/list";\n',
      "e2e/pages/list.ts": "export class ListPage {}\n",
    });
    const support = await leanedOn(
      [{ path: "e2e/add-item.spec.ts", contents: "// written this run\n", kind: "test" }],
      cwd,
      "e2e/add-item.spec.ts",
    );
    expect(support).toEqual(["e2e/pages/list.ts"]);
  });

  // The review is told what this change wrote by the files themselves; a path
  // that appears in both lists reads as a file someone else already had.
  it("leaves out a file this run wrote", async () => {
    await makeProject({
      "e2e/add-item.spec.ts": 'import { ListPage } from "./pages/list";\n',
      "e2e/pages/list.ts": "export class ListPage {}\n",
    });
    const support = await leanedOn(
      [
        { path: "e2e/add-item.spec.ts", contents: "// written this run\n", kind: "test" },
        { path: "e2e/pages/list.ts", contents: "export class ListPage { open() {} }\n", kind: "support" },
      ],
      cwd,
      "e2e/add-item.spec.ts",
    );
    expect(support).toEqual([]);
  });
});
