import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";
import { createHubServer } from "../../../src/hub/api/server.ts";
import { createFileHubStorage } from "../../../src/hub/core/storage/file/index.ts";

// End-to-end for incremental hub push: `ccqa run --report-to-hub` opens a
// "running" run on the hub, PATCHes each finished spec's row as it lands, and
// finalizes the run (running → terminal) at the end. `--push-report` alone is
// enough (it implies the default report dir); `--report <dir>` only controls
// where the local copy lives. Drives a real in-process hub (same pattern as
// src/hub/api/server.test.ts) and a mocked Claude so the live executor runs
// deterministically without network/model access.

const TOKEN = "test-token";

function mockStepMessages(stepId: string): Array<Record<string, unknown>> {
  return [
    { type: "assistant", message: { content: [{ type: "text", text: `STEP_RESULT|${stepId}|pass|ok` }] } },
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

describe("ccqa run --report-to-hub — incremental hub push", () => {
  let project: FakeProject | null = null;
  let server: Server;
  let dataDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-inc-"));
    server = createHubServer({
      storage: createFileHubStorage(dataDir),
      token: TOKEN,
      encryptionKey: null,
      allowedOrigins: [],
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dataDir, { recursive: true, force: true });
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  const hubGet = async (path: string): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };

  const listRuns = async (): Promise<Array<{ id: string; status: string; specs: { total: number } }>> => {
    const { runs } = (await hubGet("/api/v1/runs?project=demo-proj")) as {
      runs: Array<{ id: string; status: string; specs: { total: number } }>;
    };
    return runs;
  };

  test("--report-to-hub opens, patches, and finalizes a run, and writes the default local report", async () => {
    project = await makeFakeProject("run-live-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [...mockStepMessages("step-01")]);

    // No --report: --push-report implies the default report dir so it has
    // something to upload, and drives the full open → patch → finalize flow.
    const result = await runCcqa(
      ["run", "demo/x", "--project", "demo-proj", "--report-to-hub"],
      {
        cwd: project.cwd,
        env: {
          ...noColorEnv(),
          CCQA_CLAUDE_MOCK_FILE: mockPath,
          CCQA_HUB_URL: baseUrl,
          CCQA_HUB_TOKEN: TOKEN,
        },
        timeoutMs: 90_000,
      },
    );
    expect(result.exitCode).toBe(0);

    // Exactly one run reached the hub, finalized (running → terminal), and
    // carries the live spec's row (pushed incrementally, reconciled at close).
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("passed");
    expect(run.specs.total).toBe(1);
    const report = (await hubGet(`/api/v1/runs/${run.id}/report`)) as {
      results: Array<{ feature: string; spec: string; liveRun: unknown }>;
    };
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.feature).toBe("demo");
    expect(report.results[0]!.spec).toBe("x");
    expect(report.results[0]!.liveRun).not.toBeNull();

    // --push-report also writes a local copy to the default dir (ccqa-report/).
    const localReport = JSON.parse(
      await readFile(join(project.cwd, "ccqa-report", "report.json"), "utf8"),
    ) as { results: Array<{ spec: string }> };
    expect(localReport.results[0]!.spec).toBe("x");
  }, 120_000);

  test("an unreachable hub fails the run rather than going green without publishing", async () => {
    project = await makeFakeProject("run-live-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [...mockStepMessages("step-01")]);
    const reportDir = join(project.cwd, "ccqa-report");

    // A hub URL that refuses connections (a port with nothing listening).
    // --report-to-hub asked for publication; not publishing has to be visible
    // in the exit code, or CI reads "green" as "results are on the hub".
    const result = await runCcqa(
      ["run", "demo/x", "--report-dir", reportDir, "--project", "demo-proj", "--report-to-hub"],
      {
        cwd: project.cwd,
        env: {
          ...noColorEnv(),
          CCQA_CLAUDE_MOCK_FILE: mockPath,
          CCQA_HUB_URL: "http://127.0.0.1:1",
          CCQA_HUB_TOKEN: TOKEN,
        },
        timeoutMs: 90_000,
      },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    // Whichever hub read reaches the dead port first — the point is that one
    // of them stops the run instead of degrading to a local-only report.
    expect(combined).toMatch(/could not read from the hub|could not open a run on the hub/);
  }, 120_000);

  // Gate on hub-run creation: a run is opened on the hub ONLY when both
  // --push-report and hub creds are present. Uses a deterministic spec (no live
  // executor) so the two negative branches stay cheap.
  test("no run is opened without both --report-to-hub and hub creds", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const baseArgs = ["run", "demo/smoke", "--project", "demo-proj"];

    // (a) hub creds present, but --report-to-hub absent → no run opened.
    const noFlag = await runCcqa(baseArgs, {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_HUB_URL: baseUrl, CCQA_HUB_TOKEN: TOKEN },
    });
    expect(noFlag.exitCode).toBe(0);
    expect(await listRuns()).toHaveLength(0);

    // (b) --report-to-hub present, but hub creds absent → usage error, no run.
    const noCreds = await runCcqa([...baseArgs, "--report-to-hub"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_HUB_URL: "", CCQA_HUB_TOKEN: "" },
    });
    expect(noCreds.exitCode).toBe(2);
    expect(await listRuns()).toHaveLength(0);
  });
});
