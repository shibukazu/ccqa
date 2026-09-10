import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// Same shape as run-live.test.ts's mockStepMessages: one assistant text block
// plus a STEP_RESULT line, then a terminal result message.
function mockStepMessages(stepId: string, verdict: "pass" | "fail", reason: string): Array<Record<string, unknown>> {
  return [
    { type: "assistant", message: { content: [{ type: "text", text: `Working on ${stepId}…` }] } },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: `STEP_RESULT|${stepId}|${verdict}|${reason}` }] },
    },
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

/**
 * Checks whether a markdown-sourced `mode: live` case (docs/testcase, not
 * spec.yaml) produces the same per-step evidence as a spec.yaml live case:
 * before/after PNGs and non-empty reasoning for every step, and a
 * `--report-junit` system-out that lists both paths per step.
 */
describe("ccqa run (live mode, markdown-sourced case) — mocked Claude + fake agent-browser", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("both steps get before+after PNGs, non-empty reasoning, and a two-path-per-step JUnit system-out", async () => {
    project = await makeFakeProject("markdown-live", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      ...mockStepMessages("step-01", "pass", "home page greeting is visible"),
      ...mockStepMessages("step-02", "pass", "final screen is visible"),
    ]);

    const reportDir = join(project.cwd, "ccqa-report");
    const junitPath = join(project.cwd, "junit.xml");

    const result = await runCcqa(
      ["run", "demo/flow", "--report-dir", reportDir, "--report-junit", junitPath],
      {
        cwd: project.cwd,
        env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath },
        timeoutMs: 90_000,
      },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as {
      results: Array<{
        liveRun: {
          steps: Array<{ stepId: string; beforePng: string | null; afterPng: string | null; reasoning: string }>;
        } | null;
      }>;
    };
    const steps = report.results[0]?.liveRun?.steps;
    expect(steps).toBeDefined();
    expect(steps!.length).toBe(2);

    for (const step of steps!) {
      expect(step.beforePng, `${step.stepId} beforePng`).not.toBeNull();
      expect(step.afterPng, `${step.stepId} afterPng`).not.toBeNull();
      await expect(readFile(join(reportDir, step.beforePng!))).resolves.toBeInstanceOf(Buffer);
      await expect(readFile(join(reportDir, step.afterPng!))).resolves.toBeInstanceOf(Buffer);
      expect(step.reasoning.length, `${step.stepId} reasoning`).toBeGreaterThan(0);
    }

    const junitXml = await readFile(junitPath, "utf8");
    const systemOut = /<system-out>([\s\S]*?)<\/system-out>/.exec(junitXml)?.[1] ?? "";
    const paths = systemOut.split("\n").filter((line) => line.trim().length > 0);
    expect(paths.length).toBe(steps!.length * 2);
  }, 120_000);
});
