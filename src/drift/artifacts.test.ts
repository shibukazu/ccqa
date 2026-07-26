import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GENERATED_MANIFEST_FILE } from "../targets/run-command-runner.ts";
import { collectSpecArtifacts } from "./artifacts.ts";

const STEP = "steps:\n  - instruction: Open the app\n    expected: The home screen is visible\n";
const LIVE_SPEC = `title: Sample\nmode: live\n${STEP}`;
const DET_SPEC = `title: Sample\n${STEP}`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-artifacts-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function makeSpecDir(feature: string, spec: string): Promise<string> {
  const dir = join(cwd, ".ccqa/features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeManifest(
  specDir: string,
  files: Array<{ path: string; kind: "test" | "support" }>,
): Promise<void> {
  await writeFile(
    join(specDir, GENERATED_MANIFEST_FILE),
    JSON.stringify({
      target: "ext-run",
      generatedAt: "2026-01-01T00:00:00.000Z",
      files: files.map((f) => ({ ...f, sha256: "0".repeat(64) })),
    }),
    "utf8",
  );
}

describe("collectSpecArtifacts", () => {
  test("a mode: live spec has no generated surface", async () => {
    const artifacts = await collectSpecArtifacts("demo", "x", LIVE_SPEC, cwd);
    expect(artifacts.live).toBe(true);
    expect(artifacts.generated).toEqual([]);
  });

  test("a deterministic spec's test.spec.ts is read when there is no manifest", async () => {
    const dir = await makeSpecDir("demo", "x");
    await writeFile(join(dir, "test.spec.ts"), "test('flow', () => {});\n", "utf8");

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toHaveLength(1);
    expect(artifacts.generated[0]!.content).toBe("test('flow', () => {});\n");
  });

  test("a generated.json manifest is followed, including support files", async () => {
    const dir = await makeSpecDir("demo", "x");
    await mkdir(join(cwd, "e2e/pages"), { recursive: true });
    await writeFile(join(cwd, "e2e/x.spec.ts"), "test('flow', () => {});\n", "utf8");
    await writeFile(join(cwd, "e2e/pages/helper.ts"), "export const helper = 1;\n", "utf8");
    await writeManifest(dir, [
      { path: "e2e/x.spec.ts", kind: "test" },
      { path: "e2e/pages/helper.ts", kind: "support" },
    ]);

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd);
    expect(artifacts.generated.map((f) => f.path)).toEqual(["e2e/x.spec.ts", "e2e/pages/helper.ts"]);
    expect(artifacts.generated[1]!.content).toContain("export const helper");
  });

  test("a deterministic spec with nothing generated yet is not an error", async () => {
    await makeSpecDir("demo", "x");
    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd);
    expect(artifacts.live).toBe(false);
    expect(artifacts.generated).toEqual([]);
  });

  test("truncation past the total size cap shows up in the content, not silently", async () => {
    const dir = await makeSpecDir("demo", "x");
    await mkdir(join(cwd, "e2e"), { recursive: true });
    const small = "a".repeat(5_000);
    const large = "b".repeat(30_000);
    await writeFile(join(cwd, "e2e/a.spec.ts"), small, "utf8");
    await writeFile(join(cwd, "e2e/b.spec.ts"), large, "utf8");
    await writeManifest(dir, [
      { path: "e2e/a.spec.ts", kind: "test" },
      { path: "e2e/b.spec.ts", kind: "test" },
    ]);

    const artifacts = await collectSpecArtifacts("demo", "x", DET_SPEC, cwd);
    expect(artifacts.generated).toHaveLength(2);
    expect(artifacts.generated[0]!.content).toBe(small);
    expect(artifacts.generated[1]!.content).toContain("… truncated");
    expect(artifacts.generated[1]!.content.length).toBeLessThan(large.length);
  });
});
