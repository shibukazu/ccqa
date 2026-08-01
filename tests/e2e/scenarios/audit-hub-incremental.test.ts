import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { startTestHub, type TestHub } from "../_helpers/hub-server.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";
import { execFileP } from "../../../src/drift/affected.ts";

// `ccqa audit --report-to-hub` streams each spec to the hub as it lands rather
// than pushing the whole sweep at the end. What that has to buy is durability
// mid-sweep: a sweep a CI timeout kills must keep the specs it already paid to
// audit, instead of leaving them due all over again.
//
// So the assertion that matters is not "the finished sweep looks right" — the
// old batched push managed that too. It is that the audit's answer for one
// spec is already durable while the next spec is still being checked.

const TOKEN = "test-token";
const PROJECT = "demo-proj";

describe("ccqa audit --report-to-hub — incremental push", () => {
  let project: FakeProject | null = null;
  let hub: TestHub;
  /** method + path of every request the hub received, in arrival order. */
  let seen: string[];
  /** Ledger and run state read the moment the second spec's PATCH arrived. */
  let midSweep: { ledgerSpecs: string[]; runSpecs: number } | null;

  beforeEach(async () => {
    hub = await startTestHub({ token: TOKEN });
    seen = [];
    midSweep = null;

    // Fires before the hub's own handler, so by the time the *second* PATCH
    // arrives the first one has been fully applied — the client awaits each
    // patch and `--concurrency 1` keeps them ordered. That makes this a clean
    // read of "what survives if the process dies right here".
    hub.server.on("request", (req) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      seen.push(`${req.method} ${path}`);
      const patches = seen.filter((s) => s.startsWith("PATCH ")).length;
      if (req.method === "PATCH" && patches === 2 && midSweep === null) {
        void (async () => {
          const ledger = await hub.storage.driftLedger.getMerged(PROJECT);
          const runs = await hub.storage.runs.list({ project: PROJECT });
          midSweep = {
            ledgerSpecs: Object.keys(ledger.specs).sort(),
            runSpecs: runs[0]?.specs.total ?? 0,
          };
        })();
      }
    });
  });

  afterEach(async () => {
    await hub.close();
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("a spec's verdict is durable before the sweep ends", async () => {
    project = await makeFakeProject("multi-spec", { linkCcqa: true });
    // The drift ledger is keyed by branch and stamps the audited commit, so the
    // project has to be a real repo or every entry is dropped before it is
    // written.
    const git = (...args: string[]) => execFileP("git", args, { cwd: project!.cwd });
    await git("init", "--initial-branch=main");
    await git("config", "user.email", "e2e@example.com");
    await git("config", "user.name", "e2e");
    await git("add", "-A");
    await git("commit", "-m", "fixture", "--no-gpg-sign");

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    // Replayed for every invocation, so one clean verdict covers both specs.
    await writeMockMessages(mockPath, [
      { type: "result", subtype: "success", result: '{"drift": null}', is_error: false },
    ]);

    const res = await runCcqa(
      ["audit", "--project", PROJECT, "--report-to-hub", "--concurrency", "1", "--report-format", "json"],
      {
        cwd: project.cwd,
        env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath, CCQA_HUB_URL: hub.baseUrl, CCQA_HUB_TOKEN: TOKEN },
        timeoutMs: 60_000,
      },
    );
    expect(res.exitCode, stripAnsi(res.stdout + res.stderr)).toBe(0);

    // It streamed: one run opened up front, then a patch per spec plus the
    // closing one.
    expect(seen).toContain("POST /api/v1/runs/open");
    expect(seen.filter((s) => s.startsWith("PATCH ")).length).toBe(3);

    // The point of all of it: while spec two was still being audited, spec
    // one's verdict was already on the hub and already in the ledger.
    expect(midSweep).not.toBeNull();
    expect(midSweep!.ledgerSpecs).toEqual(["alpha/one"]);
    expect(midSweep!.runSpecs).toBe(1);

    const ledger = await hub.storage.driftLedger.getMerged(PROJECT);
    expect(Object.keys(ledger.specs).sort()).toEqual(["alpha/one", "beta/two"]);
  }, 120_000);
});
