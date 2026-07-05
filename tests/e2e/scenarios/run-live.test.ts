import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// Build a JSONL fixture that mirrors what the Claude Agent SDK streams to
// invokeClaudeStreaming's `onEvent` callback. The live executor only
// reads:
//   - assistant text blocks (to extract a STEP_RESULT line)
//   - the terminal result message (to set isError)
function mockStepMessages(stepId: string, verdict: "pass" | "fail", reason: string): Array<Record<string, unknown>> {
  return [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `Working on ${stepId}…` },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `STEP_RESULT|${stepId}|${verdict}|${reason}` },
        ],
      },
    },
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

describe("ccqa run (live mode) — mocked Claude + fake agent-browser", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("all steps pass: exits 0, writes per-step PNGs and run.json, --report emits report.json", async () => {
    project = await makeFakeProject("run-live-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    // CCQA_CLAUDE_MOCK_FILE replays the same JSONL on every invokeClaudeStreaming
    // call. We emit a single STEP_RESULT|step-01|pass; steps 02/03 see the same
    // line, match findLastStepResult, and pass with a "(stepId mismatch: …)"
    // prefix in reasoning — fine for verifying executor wiring.
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      ...mockStepMessages("step-01", "pass", "ok"),
    ]);

    const reportDir = join(project.cwd, "ccqa-report");

    const result = await runCcqa(["run", "demo/x", "--report", reportDir], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    // run.json exists and reports 3 passed steps.
    const runsDir = join(project.cwd, ".ccqa/features/demo/test-cases/x/runs");
    const runIds = await readDirEntries(runsDir);
    expect(runIds.length).toBe(1);
    const runJsonRaw = await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8");
    const runJson = JSON.parse(runJsonRaw) as { status: string; steps: Array<{ status: string }> };
    expect(runJson.status).toBe("passed");
    expect(runJson.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);

    // PNGs exist per step.
    const stepsDir = join(runsDir, runIds[0]!, "steps");
    for (const f of ["step-01.before.png", "step-01.after.png", "step-02.before.png", "step-03.after.png"]) {
      const s = await stat(join(stepsDir, f));
      expect(s.size).toBeGreaterThan(0);
    }

    // report.json records the live run with per-step before/after PNG paths
    // (there is no standalone HTML report — the hub UI renders from this).
    const report = JSON.parse(await readFile(join(reportDir, "report.json"), "utf8")) as {
      results: Array<{ liveRun: { steps: Array<{ beforePng: string | null; afterPng: string | null }> } | null }>;
    };
    const live = report.results[0]?.liveRun;
    expect(live).not.toBeNull();
    const pngPaths = live!.steps.flatMap((s) => [s.beforePng, s.afterPng]).filter((p): p is string => Boolean(p));
    const pngs = pngPaths.join(" ");
    expect(pngs).toMatch(/step-01\.before\.png/);
    expect(pngs).toMatch(/step-03\.after\.png/);

    // Evidence PNGs are copied into the report dir (not just referenced by
    // relative path), so reportDir is self-contained for a hub push: no path
    // escapes reportDir, every path lives under evidence/, and the copied
    // file actually exists on disk.
    for (const p of pngPaths) {
      expect(p).not.toMatch(/\.\.\//);
      expect(p).toMatch(/^evidence\//);
      const s = await stat(join(reportDir, p));
      expect(s.size).toBeGreaterThan(0);
    }
  }, 120_000);

  test("two live specs with --concurrency 2: both pass, each writes its own run.json", async () => {
    project = await makeFakeProject("run-live-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      ...mockStepMessages("step-01", "pass", "ok"),
    ]);

    const result = await runCcqa(
      ["run", "demo/x", "demo/y", "--concurrency", "2"],
      {
        cwd: project.cwd,
        env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath },
        timeoutMs: 90_000,
      },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    // Each spec ran once in its own fresh session, recorded under its own dir.
    for (const spec of ["x", "y"]) {
      const runsDir = join(project.cwd, `.ccqa/features/demo/test-cases/${spec}/runs`);
      const runIds = await readDirEntries(runsDir);
      expect(runIds.length, `runs for demo/${spec}`).toBe(1);
      const runJson = JSON.parse(
        await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8"),
      ) as { status: string };
      expect(runJson.status).toBe("passed");
    }
    expect(combined).toMatch(/2 passed \/ 0 failed/);
  }, 120_000);

  test("STEP_RESULT|...|fail aborts the run: later steps recorded as skipped, exit code 1", async () => {
    project = await makeFakeProject("run-live-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    // step-01 fails → overallFailed flips → steps 02/03 are pushed as
    // skipped without invoking Claude, so the JSONL only needs step-01's
    // fail message.
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      ...mockStepMessages("step-01", "fail", "expected greeting absent"),
    ]);

    const result = await runCcqa(["run", "demo/x"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(1);
    expect(combined).toContain("expected greeting absent");

    const runsDir = join(project.cwd, ".ccqa/features/demo/test-cases/x/runs");
    const runIds = await readDirEntries(runsDir);
    expect(runIds.length).toBe(1);
    const runJsonRaw = await readFile(join(runsDir, runIds[0]!, "run.json"), "utf8");
    const runJson = JSON.parse(runJsonRaw) as { status: string; steps: Array<{ status: string }> };
    expect(runJson.status).toBe("failed");
    expect(runJson.steps[0]!.status).toBe("failed");
    expect(runJson.steps[1]!.status).toBe("skipped");
    expect(runJson.steps[2]!.status).toBe("skipped");
  }, 120_000);
});

async function readDirEntries(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  return (await readdir(dir)).sort();
}
