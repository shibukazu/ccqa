import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noAuthEnv, stripAnsi, stubSecurityBinary } from "../_helpers/env.ts";

async function addSpec(cwd: string, feature: string, spec: string, body: string): Promise<void> {
  const dir = join(cwd, ".ccqa", "features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "test.spec.ts"), body, "utf8");
  // spec.yaml is the source of truth for spec discovery (`mode:` resolution
  // happens here). Write a minimal one so listAllSpecsWithSpecFile picks it up.
  await writeFile(
    join(dir, "spec.yaml"),
    `title: ${feature}/${spec}\nsteps:\n  - instruction: noop\n    expected: noop\n`,
    "utf8",
  );
}

describe("ccqa run — summary format is stable", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("summary shows Specs/Tests counts and per-spec rows", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    // Add one extra failing spec alongside the passing one so both halves of
    // the summary (passed/failed counts) show up.
    await addSpec(
      project.cwd,
      "demo",
      "boom",
      `import { test, expect } from "vitest";\ntest("fail", () => { expect(1).toBe(2); });\n`,
    );
    // A report is always written now, so the failing spec triggers failure
    // analysis; force the auth probe to fail so it's skipped (no Claude call).
    const result = await runCcqa(["run"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    // Header banner
    expect(combined).toMatch(/──────── ccqa summary ────────/);
    // Aggregate counts
    expect(combined).toMatch(/Specs\s+\d+\s+\(\d+ passed, \d+ failed\)/);
    expect(combined).toMatch(/Tests\s+\d+\s+\(\d+ passed, \d+ failed, \d+ skipped\)/);
    // Per-spec rows
    expect(combined).toMatch(/demo\/smoke\s+\d+\/\d+\s+passed/);
    expect(combined).toMatch(/demo\/boom\s+\d+\/\d+\s+passed/);
  });
});
