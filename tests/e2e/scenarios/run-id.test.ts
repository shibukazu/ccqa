import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// The fixture's test.spec.ts asserts process.env.CCQA_RUN_ID is set — so the
// spec only passes when `ccqa run` exposed a unique-per-run id to the replayed
// deterministic test, matching what the live path already provides.
describe("ccqa run exposes CCQA_RUN_ID to deterministic specs", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("sets CCQA_RUN_ID in the spawned vitest environment", async () => {
    project = await makeFakeProject("run-id-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/1\/1\s+passed/);
  });
});
