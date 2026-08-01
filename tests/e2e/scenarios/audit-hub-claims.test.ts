import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { startTestHub, type TestHub } from "../_helpers/hub-server.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// `ccqa audit --only-hub-audit-needed` claims the specs it is about to check
// (so a second cycle inside the same TTL window doesn't re-audit them) and
// must release that claim once it is done — success or failure. This exercises
// the success path: a `runAudit` that never throws must still release before
// exiting, or every clean CI cycle holds its claims for the full 90-minute TTL
// and the next cycle reports every spec as "already being audited".

const TOKEN = "test-token";
const PROJECT = "demo-proj";
const PROFILE = "stg";

function auditArgs(extra: string[] = []): string[] {
  return ["audit", "--only-hub-audit-needed", "--hub-profile", PROFILE, "--project", PROJECT, "--report-format", "json", ...extra];
}

describe("ccqa audit --only-hub-audit-needed — claim release", () => {
  let project: FakeProject | null = null;
  let hub: TestHub;

  beforeEach(async () => {
    hub = await startTestHub({ token: TOKEN });
    const storage = hub.storage;

    // `--only-hub-audit-needed` 404s without a perspectives document, so seed
    // one directly (no Claude call needed) listing the fixture's one spec.
    await storage.perspectives.put(
      PROJECT,
      Buffer.from(JSON.stringify({ features: [{ featureName: "demo", specs: [{ specName: "smoke" }] }] })),
    );
  });

  afterEach(async () => {
    await hub.close();
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("a successful audit releases its claim, so the next cycle can pick the spec up again", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    // No drift found — enough for `runAudit` to reach its success exit.
    await writeMockMessages(mockPath, [
      { type: "result", subtype: "success", result: '{"drift": null}', is_error: false },
    ]);
    const env = {
      ...noColorEnv(),
      CCQA_CLAUDE_MOCK_FILE: mockPath,
      CCQA_HUB_URL: hub.baseUrl,
      CCQA_HUB_TOKEN: TOKEN,
    };

    const first = await runCcqa(auditArgs(), { cwd: project.cwd, env, timeoutMs: 60_000 });
    expect(first.exitCode, stripAnsi(first.stdout + first.stderr)).toBe(0);
    const firstOut = JSON.parse(first.stdout) as { specs: unknown[]; skipped?: string };
    expect(firstOut.skipped).toBeUndefined();
    expect(firstOut.specs).toHaveLength(1);

    // Nothing was pushed to the hub (no --report-to-hub), so the drift ledger
    // is untouched — the only thing that can make the second run skip the
    // spec is the claim from the first run still being held. Started right
    // after, well inside the 90-minute TTL, so a leaked claim would still be
    // live here.
    const second = await runCcqa(auditArgs(), { cwd: project.cwd, env, timeoutMs: 60_000 });
    expect(second.exitCode, stripAnsi(second.stdout + second.stderr)).toBe(0);
    const secondOut = JSON.parse(second.stdout) as { specs: unknown[]; skipped?: string };
    expect(secondOut.skipped).not.toBe("allHeld");
    expect(secondOut.specs).toHaveLength(1);
  }, 120_000);
});
