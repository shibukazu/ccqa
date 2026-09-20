import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openCaseReader } from "../cases/reader.ts";
import { parseProjectConfig, ProjectConfigSchema } from "../config/project-config.ts";
import { collectTargets } from "./audit.ts";

const SPEC = `title: Add an item
steps:
  - instruction: Open the todo list
    expected: the list is shown
`;

const OWN_CASES = `defaultTarget: e2e
targets:
  e2e:
    kind: external
    framework: playwright
    testPath: "specs/{case}.spec.ts"
    cases: ./ccqa/cases.mjs
`;

/** Answers with one enabled case, one disabled, and a spelling list() differs on. */
const READER = `export default ({ cwd }) => ({
  list: () => ["docs/testcase/todo/add_item.md", "todo/retired"],
  load: (ref) => {
    const id = ref.replace(/^docs\\/testcase\\//, "").replace(/\\.md$/, "");
    return {
      id,
      path: \`\${cwd}/docs/testcase/\${id}.md\`,
      text: "the document",
      title: "a case",
      mode: "deterministic",
      steps: [{ instruction: "Open the todo list" }],
      disabled: id === "todo/retired",
    };
  },
});
`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-audit-targets-"));
});

describe("the cases an audit sweeps", () => {
  it("leaves a spec.yaml case's id unset, so its files stay in the spec tree", async () => {
    const dir = join(cwd, ".ccqa/features/todo/test-cases/add_item");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "spec.yaml"), SPEC, "utf8");

    const targets = await collectTargets(undefined, cwd, openCaseReader(ProjectConfigSchema.parse({}), cwd));

    expect(targets).toEqual([{ featureName: "todo", specName: "add_item" }]);
    // A `caseId` would send every path derived from it — the recording the
    // repair route looks for above all — to `.ccqa/cases/` instead.
    expect(targets[0]!.caseId).toBeUndefined();
  });

  it("addresses a case from the project's own source by the id that source answers with", async () => {
    await mkdir(join(cwd, "ccqa"), { recursive: true });
    await writeFile(join(cwd, "ccqa/cases.mjs"), READER, "utf8");

    const targets = await collectTargets(undefined, cwd, openCaseReader(parseProjectConfig(OWN_CASES), cwd));

    // Canonical, not the spelling `list()` happened to use — the same id the
    // named branch resolves to, so findings key alike either way.
    expect(targets).toEqual([{ featureName: "todo", specName: "add_item", caseId: "todo/add_item" }]);
  });
});
