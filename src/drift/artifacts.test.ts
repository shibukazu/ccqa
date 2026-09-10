import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { collectSpecArtifacts, loadSpecArtifactsContext } from "./artifacts.ts";

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

async function makeSpecDir(feature: string, spec: string): Promise<string> {
  const dir = join(cwd, ".ccqa/features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("collectSpecArtifacts", () => {
  test("a mode: live spec has no generated surface", async () => {
    const artifacts = await collectSpecArtifacts("demo", "x", LIVE_SPEC, cwd, ctx);
    expect(artifacts.live).toBe(true);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
  });

  test("a deterministic spec's generated test is read from its target's testPath", async () => {
    const dir = await makeSpecDir("demo", "x");
    await writeFile(join(dir, "test.spec.ts"), "test('flow', () => {});\n", "utf8");

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd, ctx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toHaveLength(1);
    expect(artifacts.generated[0]!.content).toBe("test('flow', () => {});\n");
  });

  test("a generated test's imports are followed, including support files", async () => {
    const dir = await makeSpecDir("demo", "x");
    await mkdir(join(cwd, "e2e/pages"), { recursive: true });
    await writeFile(
      join(dir, "test.spec.ts"),
      `import { helper } from "../../../../../e2e/pages/helper.ts";\ntest('flow', () => {});\n`,
      "utf8",
    );
    await writeFile(join(cwd, "e2e/pages/helper.ts"), "export const helper = 1;\n", "utf8");

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd, ctx);
    expect(artifacts.generated.map((f) => f.path)).toEqual([
      ".ccqa/features/demo/test-cases/x/test.spec.ts",
      "e2e/pages/helper.ts",
    ]);
    expect(artifacts.generated[1]!.content).toContain("export const helper");
  });

  test("a deterministic spec with nothing generated yet is not an error", async () => {
    await makeSpecDir("demo", "x");
    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd, ctx);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toEqual([]);
    expect(artifacts.unaudited).toEqual([]);
  });

  test("a file that does not fit the byte budget is named in unaudited, not truncated", async () => {
    const dir = await makeSpecDir("demo", "x");
    const small = `// ${"a".repeat(4990)}\n`;
    await writeFile(
      join(dir, "test.spec.ts"),
      `${small}import { big } from "../../../../../e2e/big.ts";\ntest('flow', () => {});\n`,
      "utf8",
    );
    await mkdir(join(cwd, "e2e"), { recursive: true });
    await writeFile(join(cwd, "e2e/big.ts"), "b".repeat(70_000), "utf8");

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd, ctx);
    expect(artifacts.generated).toHaveLength(1);
    expect(artifacts.generated[0]!.path).toBe(".ccqa/features/demo/test-cases/x/test.spec.ts");
    expect(artifacts.unaudited).toEqual(["e2e/big.ts"]);
  });
});
