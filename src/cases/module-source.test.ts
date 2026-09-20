import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.ts";
import { RunUsageError } from "../run/errors.ts";
import { openCaseReader } from "./reader.ts";

/**
 * The reader a consuming project writes, as the docs show it. Written to disk
 * and imported for real: the point of the contract is that ccqa knows nothing
 * about the format, so a mock of the module would test nothing.
 */
const READER = `const CASES = {
  "todo/add_item": {
    title: "Adding an item puts it on the list",
    steps: ["Open the todo list", "Type a title", "Press Add"],
  },
  "todo/nested/remove_item": {
    title: "Removing an item takes it off the list",
    steps: ["Open the todo list", "Press Delete on the first item"],
  },
};

export default function cases({ cwd }) {
  return {
    list: () => Object.keys(CASES).sort(),
    load(ref) {
      const id = ref.replace(/^docs\\/testcase\\//, "").replace(/\\.md$/, "");
      const found = CASES[id];
      if (!found) throw new Error(\`no test case for "\${ref}"\`);
      return {
        id,
        path: \`\${cwd}/docs/testcase/\${id}.md\`,
        text: found.title,
        title: found.title,
        mode: "deterministic",
        steps: found.steps.map((instruction) => ({ instruction })),
      };
    },
  };
}
`;

const CONFIG = (modulePath: string): string => `defaultTarget: e2e
targets:
  e2e:
    kind: external
    framework: playwright
    testPath: "specs/{case}.spec.ts"
    cases: ${modulePath}
`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-module-source-"));
  await mkdir(join(cwd, "ccqa"), { recursive: true });
});

async function readerFor(body: string, file = "ccqa/cases.mjs") {
  await writeFile(join(cwd, file), body, "utf8");
  return openCaseReader(parseProjectConfig(CONFIG(`./${file}`)), cwd);
}

describe("a project's own case source", () => {
  it("lists what the module lists and loads what it returns", async () => {
    const reader = await readerFor(READER);
    expect(reader.target?.id).toBe("e2e");
    expect(await reader.list()).toEqual(["todo/add_item", "todo/nested/remove_item"]);

    const testCase = await reader.load("todo/add_item");
    expect(testCase.ref.id).toBe("todo/add_item");
    // ccqa's own layout, decided by ccqa — the module never sees it.
    expect(testCase.ref.dir).toBe(join(cwd, ".ccqa/cases/todo/add_item"));
    expect(testCase.steps.map((s) => s.id)).toEqual(["step-01", "step-02", "step-03"]);
    expect(testCase.mode).toBe("deterministic");
    expect(testCase.spec).toBeNull();
    expect(testCase.document.path).toBe(join(cwd, "docs/testcase/todo/add_item.md"));
  });

  it("lets the module decide both spellings, and reads the case once", async () => {
    const reader = await readerFor(READER);
    const byPath = await reader.read("docs/testcase/todo/add_item.md");
    expect(byPath.id).toBe("todo/add_item");
    // Filed under the id the module answered with, so the second spelling is
    // the same read rather than a second one.
    expect(await reader.read("todo/add_item")).toBe(byPath);
  });

  it("reports a module that is not there, naming the key and the path", async () => {
    const reader = openCaseReader(parseProjectConfig(CONFIG("./ccqa/nope.mjs")), cwd);
    // The key that set it, and the file it resolved to.
    await expect(reader.list()).rejects.toThrow(
      `targets.e2e.cases (${join(cwd, "ccqa/nope.mjs")})`,
    );
  });

  it("points a TypeScript reader at the plain-JavaScript rule", async () => {
    const reader = await readerFor("export default () => ({});", "ccqa/cases.ts");
    await expect(reader.list()).rejects.toThrow(/plain JavaScript \(\.mjs, \.js, \.cjs\)/);
    await expect(reader.list()).rejects.toThrow(/Write it as \.mjs/);
  });

  it("refuses a module whose default export is not a factory", async () => {
    const reader = await readerFor("export const cases = 1;\n");
    await expect(reader.list()).rejects.toThrow(/must default-export a function taking \{ cwd \}/);
  });

  it("refuses a factory that does not return a source", async () => {
    const reader = await readerFor("export default () => ({ list: () => [] });\n");
    await expect(reader.list()).rejects.toThrow(/must return an object with list\(\) and load\(\)/);
  });

  it("sorts and de-duplicates what list() returns, so no case runs twice", async () => {
    const reader = await readerFor(
      `export default () => ({ list: () => ["b", "a", "b"], load: () => ({}) });\n`,
    );
    expect(await reader.list()).toEqual(["a", "b"]);
  });

  it("refuses a list() that is not case ids", async () => {
    const reader = await readerFor(
      "export default () => ({ list: () => [1, 2], load: () => ({}) });\n",
    );
    await expect(reader.list()).rejects.toThrow(/list\(\) must return an array of case ids/);
  });

  it("names every field a malformed case got wrong", async () => {
    const reader = await readerFor(
      `export default () => ({
        list: () => ["x"],
        load: () => ({ id: "x", path: "/p", text: "", title: "", mode: "sometimes", steps: [] }),
      });\n`,
    );
    const failure = reader.load("x");
    await expect(failure).rejects.toThrow(/load\("x"\) returned a value that is not a case/);
    await expect(failure).rejects.toThrow(/title:/);
    await expect(failure).rejects.toThrow(/mode:/);
    await expect(failure).rejects.toThrow(/steps:/);
  });

  it("refuses a case id that would escape the project's own directories", async () => {
    const reader = await readerFor(
      `export default () => ({
        list: () => ["x"],
        load: () => ({ id: "../outside", path: "/p", text: "", title: "t", mode: "live", steps: [{ instruction: "go" }] }),
      });\n`,
    );
    await expect(reader.load("x")).rejects.toThrow(/id: .*'\.\.'/);
  });

  it("lets a load() failure through as the module worded it, as a usage error", async () => {
    const reader = await readerFor(READER);
    // The operator mistyped an argument; every command that takes a `<case>`
    // maps this to `[error] …` and exit 2 rather than a stack trace.
    const failure = reader.load("todo/nope");
    await expect(failure).rejects.toThrow('no test case for "todo/nope"');
    await expect(failure).rejects.toBeInstanceOf(RunUsageError);
  });

  it("reports an unreadable case through read() rather than raising", async () => {
    const reader = await readerFor(READER);
    const read = await reader.read("todo/nope");
    expect(read.case).toBeNull();
    expect(read.document).toBeNull();
    expect(read.error).toContain('no test case for "todo/nope"');
  });

  it("does not import the module until something asks it a question", async () => {
    // A command that never reaches a case (a bad flag, `--help`) must not pay
    // to import the module, nor fail on one that is broken.
    const reader = openCaseReader(parseProjectConfig(CONFIG("./ccqa/never-written.mjs")), cwd);
    expect(reader.target?.module).toBe("./ccqa/never-written.mjs");
  });
});
