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

describe("loadSpecInventory — a project's own case source", () => {
  const CONFIG = `defaultTarget: todo-e2e
targets:
  todo-e2e:
    kind: external
    framework: playwright
    testPath: specs/{case}.spec.ts
    cases: ./ccqa/cases.mjs
`;

/**
 * A case source as a project writes one. The format is that project's
 * business, so a test picks whatever is simplest to state — here a table.
 */
const READER = `const CASES = {
  "todo/add-item": { title: "Adding an item puts it on the list", mode: "deterministic" },
  "todo/see-list": { title: "The list shows every item", mode: "live" },
};

export default ({ cwd }) => ({
  list: () => Object.keys(CASES).sort(),
  load: (ref) => {
    const id = ref.replace(/^docs\\/testcase\\//, "").replace(/\\.md$/, "");
    return {
      ...CASES[id],
      id,
      path: \`\${cwd}/docs/testcase/\${id}.md\`,
      text: "the case, as its author wrote it",
      steps: [{ instruction: "Open the todo list" }, { instruction: 'Add "Buy milk"' }],
    };
  },
});
`;

  it("reads the project's own cases instead of .ccqa/features/, with testPath through its target", async () => {
    const cwd = await makeProject({ ".ccqa/config.yaml": CONFIG, "ccqa/cases.mjs": READER });

    const specs = await loadSpecInventory(cwd);

    expect(specs.map((s) => s.specName)).toEqual(["add-item", "see-list"]);
    expect(specs[0]).toMatchObject({
      featureName: "todo",
      specName: "add-item",
      title: "Adding an item puts it on the list",
      steps: ["Open the todo list", 'Add "Buy milk"'],
      includedBlocks: [],
      testPath: "specs/todo/add-item.spec.ts",
      sourcePath: "docs/testcase/todo/add-item.md",
    });
  });

  it("resolves a live case's testPath to empty, same as a live spec.yaml", async () => {
    const cwd = await makeProject({ ".ccqa/config.yaml": CONFIG, "ccqa/cases.mjs": READER });

    const specs = await loadSpecInventory(cwd);

    expect(specs.find((s) => s.specName === "see-list")!.testPath).toBe("");
  });
});
