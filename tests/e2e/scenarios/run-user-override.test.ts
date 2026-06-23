import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv } from "../_helpers/env.ts";

// Locks in PR #12 behavior: a .ccqa/vitest.config.ts in the project takes
// priority over the bundled config. The fixture's config wires up a
// globalSetup that touches a sentinel file; the test asserts the file exists.
describe("ccqa run — .ccqa/vitest.config.ts overrides bundled config", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("user override config is honored", async () => {
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
