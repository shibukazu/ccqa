import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// End-to-end check of CCQA_STEP step attribution and CCQA_ASSERT promotion
// during `ccqa record` (trace): the mocked Claude replays Bash tool_use blocks
// whose commands carry the CCQA_STEP=<step-id> / CCQA_ASSERT=<marker> env
// prefixes, the replay shim fires the PreToolUse hooks, and the recorded
// actions must land in ir.json with the right stepId — with NO STEP_START
// text line for step-02/step-03 and NO AB_ACTION|assert text line for the
// marked commands, proving neither attribution nor assertions depend on the
// text protocol.
function mockTraceMessages(): Array<Record<string, unknown>> {
  const bash = (id: string, command: string): Record<string, unknown> => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
  const text = (t: string): Record<string, unknown> => ({
    type: "assistant",
    message: { content: [{ type: "text", text: t }] },
  });
  return [
    text("STEP_START|step-01|Open the page"),
    bash("tu_1", `CCQA_STEP=step-01 agent-browser --session s1 open about:blank`),
    // step-02 emits NO STEP_START line — only the command prefix names it.
    bash("tu_2", `CCQA_STEP=step-02 agent-browser --session s1 click "text=Next"`),
    // Text-channel assert must attach to step-02 via the prefix-advanced step.
    text("AB_ACTION|assert|url_contains||about:blank|still on the page"),
    // step-03: every assertion comes from CCQA_ASSERT markers on the
    // verification commands themselves — no protocol text at all.
    bash("tu_3", `CCQA_STEP=step-03 CCQA_ASSERT=1 agent-browser --session s1 wait --text "Ready" --timeout 3000`),
    bash("tu_4", `CCQA_STEP=step-03 CCQA_ASSERT=element_visible agent-browser --session s1 get count "[data-qa='panel']"`),
    bash("tu_5", `CCQA_STEP=step-03 CCQA_ASSERT=url_contains:about agent-browser --session s1 get url`),
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

describe("ccqa record — CCQA_STEP prefix step attribution (mocked Claude)", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("ir.json carries stepIds and marker-promoted asserts; test.spec.ts stays free of CCQA_* prefixes", async () => {
    project = await makeFakeProject("record-trace-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockTraceMessages());

    const result = await runCcqa(["record", "demo/x"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        // Route the CLI's own spawnAB (post-trace validation) to the fake —
        // module resolution from the repo checkout would find the real one.
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        // The generated test asserts url_contains via `get url`; make the
        // fake echo it so validation and the auto-fix vitest run pass.
        CCQA_FAKE_AB_STDOUT: "about:blank",
        // ... and `get count` polls (element_visible assert) must see >=1.
        CCQA_FAKE_AB_COUNT: "1",
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const caseDir = join(project.cwd, ".ccqa/features/demo/test-cases/x");
    const ir = JSON.parse(await readFile(join(caseDir, "ir.json"), "utf8")) as Array<{
      action: string;
      assert?: string;
      value?: string;
      locator?: { by: string; value: string };
      stepId?: string;
    }>;
    expect(ir.map((a) => [a.action, a.assert, a.stepId])).toEqual([
      ["navigate", undefined, "step-01"],
      ["click", undefined, "step-02"],
      ["assert", "url_contains", "step-02"],
      // step-03: promoted from CCQA_ASSERT markers. The marked `wait --text`
      // is REPLACED by its assert (no wait action anywhere), and the `get
      // count` / `get url` probes record only their asserts.
      ["assert", "text_visible", "step-03"],
      ["assert", "element_visible", "step-03"],
      ["assert", "url_contains", "step-03"],
    ]);
    expect(ir[3]!.value).toBe("Ready");
    expect(ir[4]!.locator).toEqual({ by: "css", value: "[data-qa='panel']" });
    expect(ir[5]!.value).toBe("about");

    // The prefixes are trace-time plumbing only — they must never survive
    // into the generated test script, while the promoted asserts must.
    const generated = await readFile(join(caseDir, "test.spec.ts"), "utf8");
    expect(generated).not.toMatch(/CCQA_STEP|CCQA_ASSERT/);
    expect(generated).toMatch(/\/\/ step: step-02/);
    expect(generated).toMatch(/abAssertTextVisible\(/);
    expect(generated).toMatch(/abAssertVisible\(/);
    expect(generated).toMatch(/abAssertUrl\(/);
  }, 120_000);
});
