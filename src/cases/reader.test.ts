import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseProjectConfig, ProjectConfigSchema } from "../config/project-config.ts";
import { splitCaseId } from "../store/index.ts";
import { resolveCaseTestPath } from "../targets/test-path.ts";
import { openCaseReader } from "./reader.ts";

const SPEC = `title: Add an item
steps:
  - instruction: Open the todo list
    expected: the list is shown
`;

const OWN_CASES_CONFIG = `defaultTarget: e2e
targets:
  e2e:
    kind: external
    framework: playwright
    testPath: "e2e/{case}.spec.ts"
    runCommand: "true {files}"
    cases: ./ccqa/cases.mjs
`;

/** The smallest reader that answers the contract, for the door's own tests. */
const READER = `export default ({ cwd }) => ({
  list: () => ["todo/add_item", "top_level"],
  load: (ref) => {
    const id = ref.replace(/^docs\\/testcase\\//, "").replace(/\\.md$/, "");
    return {
      id,
      path: \`\${cwd}/docs/testcase/\${id}.md\`,
      text: "the document",
      title: "Adding an item puts it on the list",
      mode: "deterministic",
      steps: [{ instruction: "Open the todo list" }],
    };
  },
});
`;

async function specProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ccqa-reader-"));
  await mkdir(join(cwd, ".ccqa/features/todo/test-cases/add_item"), { recursive: true });
  await writeFile(join(cwd, ".ccqa/features/todo/test-cases/add_item/spec.yaml"), SPEC, "utf8");
  return cwd;
}

describe("the reader over ccqa's own specs", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await specProject();
  });

  it("lists every case with a spec file, by id", async () => {
    const reader = openCaseReader(ProjectConfigSchema.parse({}), cwd);
    expect(await reader.list()).toEqual(["todo/add_item"]);
    expect(reader.target).toBeNull();
  });

  it("reads the spec's own document, and keeps the parsed spec for the readers that need it", async () => {
    const reader = openCaseReader(ProjectConfigSchema.parse({}), cwd);
    const testCase = await reader.load("todo/add_item");
    expect(testCase.title).toBe("Add an item");
    expect(testCase.document.text).toBe(SPEC);
    expect(testCase.document.path).toBe(
      join(cwd, ".ccqa/features/todo/test-cases/add_item/spec.yaml"),
    );
    expect(testCase.spec?.title).toBe("Add an item");
    expect(testCase.disabled).toBe(false);
  });

  it("accepts every spelling of a spec id as the same case, and reads it once", async () => {
    const reader = openCaseReader(ProjectConfigSchema.parse({}), cwd);
    const a = await reader.read("todo/add_item");
    const b = await reader.read(".ccqa/features/todo/test-cases/add_item");
    // Same object, not merely equal: a second read would show a mid-command
    // edit rather than what the command decided on.
    expect(a).toBe(b);
    expect(b.id).toBe("todo/add_item");
  });

  it("says a case is missing rather than throwing, so a sweep can route it", async () => {
    const reader = openCaseReader(ProjectConfigSchema.parse({}), cwd);
    const read = await reader.read("todo/nope");
    expect(read.document).toBeNull();
    expect(read.case).toBeNull();
    expect(read.document).toBeNull();
    await expect(reader.load("todo/nope")).rejects.toThrow(/spec\.yaml/i);
  });

  it("carries a document that will not parse, so the audit still reads what was written", async () => {
    await writeFile(
      join(cwd, ".ccqa/features/todo/test-cases/add_item/spec.yaml"),
      "title: [unclosed\n",
      "utf8",
    );
    const read = await openCaseReader(ProjectConfigSchema.parse({}), cwd).read("todo/add_item");
    expect(read.case).toBeNull();
    expect(read.error).toBeTruthy();
    expect(read.document?.text).toContain("unclosed");
  });

  it("reports a disabled spec rather than hiding it, so the inventory keeps listing it", async () => {
    await writeFile(
      join(cwd, ".ccqa/features/todo/test-cases/add_item/spec.yaml"),
      `${SPEC}disabled: true\n`,
      "utf8",
    );
    const reader = openCaseReader(ProjectConfigSchema.parse({}), cwd);
    expect(await reader.list()).toEqual(["todo/add_item"]);
    expect((await reader.load("todo/add_item")).disabled).toBe(true);
  });
});

describe("the reader over a project's own case source", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-reader-"));
    await mkdir(join(cwd, "ccqa"), { recursive: true });
    await writeFile(join(cwd, "ccqa/cases.mjs"), READER, "utf8");
  });

  it("answers for the target that declared the source", async () => {
    const reader = openCaseReader(parseProjectConfig(OWN_CASES_CONFIG), cwd);
    expect(reader.target?.id).toBe("e2e");
    expect(reader.target?.modulePath).toBe(join(cwd, "ccqa/cases.mjs"));
    expect(await reader.list()).toEqual(["todo/add_item", "top_level"]);
    expect((await reader.load("docs/testcase/todo/add_item.md")).ref.id).toBe("todo/add_item");
  });
});

/**
 * A case id is path-shaped, and the report rows and the hub still spell a case
 * as a feature and a spec. The join is how the two stay addressable as one
 * thing — including for an id of a single segment, where the split doubles it.
 * Pinned because the doubled key is a hub lock id and an audit-need key: if it
 * ever changes, a project's history stops matching its cases.
 */
describe("a case id splits the way the hub spells one", () => {
  it("splits a path-shaped id at its last segment", () => {
    expect(splitCaseId("todo/nested/remove_item")).toEqual({
      featureName: "todo/nested",
      specName: "remove_item",
    });
  });

  it("doubles a single-segment id rather than leaving a half-empty key", () => {
    expect(splitCaseId("top_level")).toEqual({
      featureName: "top_level",
      specName: "top_level",
    });
  });

  it("resolves a case's test from its id, so every command looks in one place", () => {
    const target = { defaultTestPath: "e2e/{case}.spec.ts" };
    // The split is for addressing a row, never for finding a file: routing a
    // single-segment case through `{feature}/{spec}` put its test at
    // `top_level/top_level` while `ccqa generate` wrote `top_level`.
    expect(resolveCaseTestPath(target, {}, "top_level")).toBe("e2e/top_level.spec.ts");
    expect(resolveCaseTestPath(target, {}, "todo/add_item")).toBe("e2e/todo/add_item.spec.ts");
  });
});
