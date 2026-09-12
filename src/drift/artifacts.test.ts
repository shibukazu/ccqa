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

describe("collectCaseArtifacts — markdown case", () => {
  const CASE_ID = "todo/add_item";
  const CASE_MD = `## Title

Adding an item puts it on the list

## Steps

1. Open the todo list
2. Add "Buy milk"

## Expected

- The item appears on the list
`;
  /** External target reading its cases from markdown, one heading mapped to mode. */
  const CONFIG = `defaultTarget: todo-e2e
targets:
  todo-e2e:
    kind: external
    framework: playwright
    testPath: specs/{case}.spec.ts
    intent:
      kind: markdown
      root: docs/testcase
      fields:
        mode: Mode
`;

  let mdCwd: string;
  let mdCtx: Awaited<ReturnType<typeof loadSpecArtifactsContext>>;

  beforeEach(async () => {
    mdCwd = await mkdtemp(join(tmpdir(), "ccqa-artifacts-md-"));
    await mkdir(join(mdCwd, ".ccqa"), { recursive: true });
    await writeFile(join(mdCwd, ".ccqa/config.yaml"), CONFIG, "utf8");
    await mkdir(join(mdCwd, "docs/testcase/todo"), { recursive: true });
    mdCtx = await loadSpecArtifactsContext(mdCwd);
  });

  afterEach(async () => {
    await rm(mdCwd, { recursive: true, force: true });
  });

  function caseTarget(): SpecTarget {
    return { ...splitCaseId(CASE_ID), caseId: CASE_ID };
  }

  test("reads the case document verbatim into intent.body, with intent.kind markdown", async () => {
    await writeFile(join(mdCwd, "docs/testcase/todo/add_item.md"), CASE_MD, "utf8");

    const artifacts = await collectCaseArtifacts(caseTarget(), mdCwd, mdCtx);
    expect(artifacts.intent).toEqual({
      kind: "markdown",
      path: "docs/testcase/todo/add_item.md",
      body: CASE_MD,
    });
  });

  test("the generated test is resolved through the intent target's testPath template", async () => {
    await writeFile(join(mdCwd, "docs/testcase/todo/add_item.md"), CASE_MD, "utf8");
    await mkdir(join(mdCwd, "specs/todo"), { recursive: true });
    await writeFile(join(mdCwd, "specs/todo/add_item.spec.ts"), "test('flow', () => {});\n", "utf8");

    const artifacts = await collectCaseArtifacts(caseTarget(), mdCwd, mdCtx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toEqual([
      { path: "specs/todo/add_item.spec.ts", content: "test('flow', () => {});\n" },
    ]);
  });

  test("a markdown case whose mode heading says live comes back live, with no generated files", async () => {
    await writeFile(
      join(mdCwd, "docs/testcase/todo/add_item.md"),
      `${CASE_MD}\n## Mode\n\nlive\n`,
      "utf8",
    );

    const artifacts = await collectCaseArtifacts(caseTarget(), mdCwd, mdCtx);
    expect(artifacts.live).toBe(true);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
  });
});
