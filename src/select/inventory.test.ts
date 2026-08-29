import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSpecInventory } from "./inventory.ts";

let cwd: string;

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function makeProject(files: Record<string, string>): Promise<string> {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-inventory-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return cwd;
}

describe("loadSpecInventory", () => {
  it("leaves out the specs marked disabled, so selection never proposes one", async () => {
    const spec = (extra = "") =>
      `title: T\n${extra}steps:\n  - instruction: go\n    expected: there\n`;
    const cwd = await makeProject({
      ".ccqa/features/shop/test-cases/on/spec.yaml": spec(),
      ".ccqa/features/shop/test-cases/off/spec.yaml": spec("disabled: true\n"),
    });
    const names = (await loadSpecInventory(cwd)).map((s) => s.specName);
    expect(names).toEqual(["on"]);
  });

  it("inlines an include step's block steps instead of naming the block", async () => {
    await makeProject({
      ".ccqa/blocks/login/spec.yaml": `title: Login
steps:
  - instruction: enter the username
    expected: the username field shows it
`,
      ".ccqa/features/checkout/test-cases/buy/spec.yaml": `title: buy an item
steps:
  - include: login
  - instruction: click buy
    expected: order confirmed
`,
    });

    const specs = await loadSpecInventory(cwd);
    const spec = specs.find((s) => s.specName === "buy")!;

    expect(spec.steps).toEqual([
      "enter the username → the username field shows it",
      "click buy → order confirmed",
    ]);
    // The mechanical block-touch path (analyze.ts) still matches on the
    // block name, so the list survives even though the steps are inlined.
    expect(spec.includedBlocks).toEqual(["login"]);
  });

  it("falls back to naming the block when it cannot be resolved, without dropping the spec", async () => {
    await makeProject({
      ".ccqa/features/checkout/test-cases/buy/spec.yaml": `title: buy an item
steps:
  - include: missing-block
  - instruction: click buy
    expected: order confirmed
`,
    });

    const specs = await loadSpecInventory(cwd);
    const spec = specs.find((s) => s.specName === "buy")!;

    expect(spec.steps).toEqual(["include block: missing-block", "click buy → order confirmed"]);
  });
});
