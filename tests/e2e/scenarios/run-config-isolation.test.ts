import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// Locks in PR #12 behavior: ccqa run passes --config <bundled> so the host
// project's vitest.config.ts is not discovered. The fixture's top-level
// vitest.config.ts throws on import; if it ever leaks in, this test fails.
describe("ccqa run — host vitest.config.ts must not leak in", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("passes despite a throwing host vitest.config.ts", async () => {
    project = await makeFakeProject("host-config-leak", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).not.toMatch(/host config leaked/);
  });
});
