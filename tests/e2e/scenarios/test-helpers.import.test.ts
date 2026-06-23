import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";

describe("ccqa/test-helpers — ab() integration", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("ab() spawns agent-browser with the right argv", async () => {
    project = await makeFakeProject("with-test-helpers", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const logPath = join(project.cwd, "ab.log");
    const result = await runCcqa(["run", "demo/helper-smoke"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_FAKE_AB_LOG: logPath },
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const log = await readFile(logPath, "utf8");
    const lines = log.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(["click", "[data-test=btn]"]);
  });

  test("agent-browser nonzero exit surfaces as a test failure", async () => {
    project = await makeFakeProject("with-test-helpers", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const result = await runCcqa(["run", "demo/helper-smoke"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_FAKE_AB_LOG: join(project.cwd, "ab.log"),
        CCQA_FAKE_AB_EXIT: "2",
      },
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toMatch(/agent-browser click failed \(exit 2\)/);
  });
});
