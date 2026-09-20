import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { splitCaseId } from "../store/index.ts";
import { collectCaseArtifacts, loadSpecArtifactsContext } from "./artifacts.ts";
import type { SpecTarget } from "./types.ts";

const STEP = "steps:\n  - instruction: Open the app\n    expected: The home screen is visible\n";
const LIVE_SPEC = `title: Sample\nmode: live\n${STEP}`;
const DET_SPEC = `title: Sample\n${STEP}`;

let cwd: string;
/** No `.ccqa/config.yaml` in the fixture: every target keeps its own defaults. */
let ctx: Awaited<ReturnType<typeof loadSpecArtifactsContext>>;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-artifacts-"));
  ctx = await loadSpecArtifactsContext(cwd);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Creates the spec's directory and writes its spec.yaml, which collectCaseArtifacts now reads itself. */
async function makeSpecDir(feature: string, spec: string, yaml: string): Promise<string> {
  const dir = join(cwd, ".ccqa/features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec.yaml"), yaml, "utf8");
  return dir;
}

function specTarget(featureName: string, specName: string): SpecTarget {
  return { featureName, specName };
}

describe("collectCaseArtifacts — spec.yaml case", () => {
  test("a mode: live spec has no generated surface", async () => {
    await makeSpecDir("demo", "x", LIVE_SPEC);

    const artifacts = await collectCaseArtifacts(specTarget("demo", "x"), cwd, ctx);
    expect(artifacts.live).toBe(true);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
    expect(artifacts.intent).toEqual({
      kind: "spec",
      path: ".ccqa/features/demo/test-cases/x/spec.yaml",
      body: LIVE_SPEC,
    });
  });

  test("a deterministic spec's generated test is read from its target's testPath", async () => {
    const dir = await makeSpecDir("demo", "x", DET_SPEC);
    await writeFile(join(dir, "test.spec.ts"), "test('flow', () => {});\n", "utf8");

    const artifacts = await collectCaseArtifacts(specTarget("demo", "x"), cwd, ctx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toHaveLength(1);
    expect(artifacts.generated[0]!.content).toBe("test('flow', () => {});\n");
  });

  test("a generated test's imports are followed, including support files", async () => {
    const dir = await makeSpecDir("demo", "x", DET_SPEC);
    await mkdir(join(cwd, "e2e/pages"), { recursive: true });
    await writeFile(
      join(dir, "test.spec.ts"),
      `import { helper } from "../../../../../e2e/pages/helper.ts";\ntest('flow', () => {});\n`,
      "utf8",
    );
    await writeFile(join(cwd, "e2e/pages/helper.ts"), "export const helper = 1;\n", "utf8");

    const artifacts = await collectCaseArtifacts(specTarget("demo", "x"), cwd, ctx);
    expect(artifacts.generated.map((f) => f.path)).toEqual([
      ".ccqa/features/demo/test-cases/x/test.spec.ts",
      "e2e/pages/helper.ts",
    ]);
    expect(artifacts.generated[1]!.content).toContain("export const helper");
  });

  test("a deterministic spec with nothing generated yet is not an error", async () => {
    await makeSpecDir("demo", "x", DET_SPEC);
    const artifacts = await collectCaseArtifacts(specTarget("demo", "x"), cwd, ctx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
  });

  test("a file that does not fit the byte budget is named in unaudited, not truncated", async () => {
    const dir = await makeSpecDir("demo", "x", DET_SPEC);
    const small = `// ${"a".repeat(4990)}\n`;
    await writeFile(
      join(dir, "test.spec.ts"),
      `${small}import { big } from "../../../../../e2e/big.ts";\ntest('flow', () => {});\n`,
      "utf8",
    );
    await mkdir(join(cwd, "e2e"), { recursive: true });
    await writeFile(join(cwd, "e2e/big.ts"), "b".repeat(70_000), "utf8");

    const artifacts = await collectCaseArtifacts(specTarget("demo", "x"), cwd, ctx);
    expect(artifacts.generated).toHaveLength(1);
    expect(artifacts.generated[0]!.path).toBe(".ccqa/features/demo/test-cases/x/test.spec.ts");
    expect(artifacts.unaudited).toEqual(["e2e/big.ts"]);
  });
});

describe("collectCaseArtifacts — a case from the project's own source", () => {
  const CASE_ID = "todo/add_item";
  const DOCUMENT = "Adding an item puts it on the list, however this project writes that down.";
  const CONFIG = `defaultTarget: todo-e2e
targets:
  todo-e2e:
    kind: external
    framework: playwright
    testPath: specs/{case}.spec.ts
    cases: ./ccqa/cases.mjs
`;
  /** `CCQA_TEST_MODE` lets one reader stand in for both a recorded and a live case. */
  const READER = `export default ({ cwd }) => ({
  list: () => ["todo/add_item"],
  load: (id) => ({
    id,
    path: \`\${cwd}/docs/testcase/\${id}.md\`,
    text: ${JSON.stringify(DOCUMENT)},
    title: "Adding an item puts it on the list",
    mode: process.env.CCQA_TEST_MODE ?? "deterministic",
    steps: [{ instruction: "Open the todo list" }],
  }),
});
`;

  let ownCwd: string;
  let ownCtx: Awaited<ReturnType<typeof loadSpecArtifactsContext>>;

  beforeEach(async () => {
    ownCwd = await mkdtemp(join(tmpdir(), "ccqa-artifacts-own-"));
    await mkdir(join(ownCwd, ".ccqa"), { recursive: true });
    await writeFile(join(ownCwd, ".ccqa/config.yaml"), CONFIG, "utf8");
    await mkdir(join(ownCwd, "ccqa"), { recursive: true });
    await writeFile(join(ownCwd, "ccqa/cases.mjs"), READER, "utf8");
    ownCtx = await loadSpecArtifactsContext(ownCwd);
  });

  afterEach(async () => {
    delete process.env["CCQA_TEST_MODE"];
    await rm(ownCwd, { recursive: true, force: true });
  });

  function caseTarget(): SpecTarget {
    return { ...splitCaseId(CASE_ID), caseId: CASE_ID };
  }

  test("reads the case document verbatim, and calls the kind the project's own", async () => {
    const artifacts = await collectCaseArtifacts(caseTarget(), ownCwd, ownCtx);
    expect(artifacts.intent).toEqual({
      kind: "project",
      path: "docs/testcase/todo/add_item.md",
      body: DOCUMENT,
    });
  });

  test("the generated test is resolved through the owning target's testPath template", async () => {
    await mkdir(join(ownCwd, "specs/todo"), { recursive: true });
    await writeFile(join(ownCwd, "specs/todo/add_item.spec.ts"), "test('flow', () => {});\n", "utf8");

    const artifacts = await collectCaseArtifacts(caseTarget(), ownCwd, ownCtx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toEqual([
      { path: "specs/todo/add_item.spec.ts", content: "test('flow', () => {});\n" },
    ]);
  });

  test("a case the source calls live comes back live, with no generated files", async () => {
    process.env["CCQA_TEST_MODE"] = "live";
    const ctx = await loadSpecArtifactsContext(ownCwd);

    const artifacts = await collectCaseArtifacts(caseTarget(), ownCwd, ctx);
    expect(artifacts.live).toBe(true);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
  });
});
