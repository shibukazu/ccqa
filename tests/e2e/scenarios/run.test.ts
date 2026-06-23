import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

describe("ccqa run", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("passes with exit 0 on a trivially passing spec", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/1\/1\s+passed/);
  });

  test("exits non-zero and renders a failing spec entry", async () => {
    project = await makeFakeProject("failing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/boom"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toMatch(/demo\/boom/);
    expect(combined).toMatch(/1\s+failed/);
  });
});
