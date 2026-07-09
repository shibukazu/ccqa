import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// Locks in PR #12 behavior for vitest config resolution, both directions:
//   1. the host project's own vitest.config.ts must NOT leak into `ccqa run`
//      (ccqa passes --config <bundled> to isolate it), and
//   2. a project's .ccqa/vitest.config.ts DOES take priority over the bundled
//      config. Both require the real subprocess config-resolution, so they
//      can't be unit-tested.
describe("ccqa run — vitest config resolution", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("host vitest.config.ts does not leak in", async () => {
    // The fixture's top-level vitest.config.ts throws on import; if it ever
    // leaks in, this run fails.
    project = await makeFakeProject("host-config-leak", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).not.toMatch(/host config leaked/);
  });

  test(".ccqa/vitest.config.ts overrides the bundled config", async () => {
    // The fixture's config wires up a globalSetup that touches a sentinel file;
    // if the override is honored the file exists after the run.
    project = await makeFakeProject("user-override-config", { linkCcqa: true });
    const sentinel = join(project.cwd, "sentinel.txt");
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_TEST_SENTINEL: sentinel },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    await expect(access(sentinel)).resolves.toBeUndefined();
  });
});
