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
// text line for step-02/step-03, proving attribution does not depend on the
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
    // step-03: every assertion comes from CCQA_ASSERT markers on the
    // verification commands themselves — no protocol text at all.
    bash("tu_3", `CCQA_STEP=step-03 CCQA_ASSERT=1 agent-browser --session s1 wait --text "Ready" --timeout 3000`),
    bash("tu_4", `CCQA_STEP=step-03 CCQA_ASSERT=element_visible agent-browser --session s1 get count "[data-qa='panel']"`),
    bash("tu_5", `CCQA_STEP=step-03 CCQA_ASSERT=url_contains:about agent-browser --session s1 get url`),
    text("RUN_COMPLETED|passed|all steps done"),
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

// `get count` takes plain CSS and answers 0 — not an error — for Playwright's
// notation, so an assert recorded as `text=<string>` would read as an element
// that is not there. It is recorded as a text locator instead, and the replay
// asks it with `wait --text`. The `${ITEM_NAME}` ref is the other half: what
// the browser was asked is resolved, what the route keeps is not.
function mockTextFallbackTraceMessages(): Array<Record<string, unknown>> {
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
    // Recorded via a CCQA_ASSERT marker on the `get count` probe itself — see
    // `promoteMarkedAssert` — with a `text=` selector that carries a `${VAR}`
    // ref, so the test can check the ref survives the rewrite unresolved.
    bash(
      "tu_2",
      `CCQA_STEP=step-01 CCQA_ASSERT=element_visible agent-browser --session s1 get count "text=Add \${ITEM_NAME}"`,
    ),
    text("RUN_COMPLETED|passed|all steps done"),
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

describe("ccqa record — a text= locator is named rather than counted", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("a text= assert whose get-count poll misses is kept via wait --text, and ir.json/output reflect the rewrite", async () => {
    project = await makeFakeProject("record-trace-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockTextFallbackTraceMessages());
    const abLogPath = join(project.cwd, "ab.log");

    const result = await runCcqa(["record", "demo/x"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        // Every `get count` poll misses (0); `wait --text` still defaults to
        // exit 0, so the retry succeeds.
        CCQA_FAKE_AB_COUNT: "0",
        CCQA_FAKE_AB_LOG: abLogPath,
        ITEM_NAME: "Widget",
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const caseDir = join(project.cwd, ".ccqa/features/demo/test-cases/x");
    const recording = JSON.parse(await readFile(join(caseDir, "ir.json"), "utf8")) as {
      actions: Array<{
        action: string;
        assert?: string;
        value?: string;
        locator?: { by: string; value: string };
        replayUnstable?: boolean;
      }>;
    };
    const ir = recording.actions;
    expect(ir.map((a) => [a.action, a.assert])).toEqual([
      ["navigate", undefined],
      ["assert", "element_visible"],
    ]);
    // Kept (not dropped, not flagged unstable), named for what it addresses,
    // and — critically — still holding the `${ITEM_NAME}` ref unresolved: only
    // the `wait --text` actually run against the browser saw the resolved one.
    expect(ir[1]!.replayUnstable).toBeFalsy();
    expect(ir[1]!.locator).toEqual({ by: "text", value: "Add ${ITEM_NAME}" });

    // Nothing to promote: the recording never wrote it as a CSS selector, so
    // there is no mis-written form for the replay to rename. (An `ir.json`
    // recorded before this is renamed at replay — see replay-validate.test.ts.)
    expect(combined).not.toContain("locator rewritten");

    const abLog = (await readFile(abLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    expect(
      abLog.some((argv) => argv.includes("wait") && argv.includes("--text") && argv.includes("Add Widget")),
    ).toBe(true);
  }, 120_000);
});

// A recorder reads `combobox "Category *"` off a snapshot and writes
// `[aria-label='Category *']`, which is valid CSS but matches nothing when
// the name actually comes from an associated `<label>`. The `get count` poll
// this drives therefore misses, and the validator must fall back to asking
// the accessibility tree for a node with that exact accessible name instead
// of reading the miss as "the element is gone".
function mockAttributeNameTraceMessages(): Array<Record<string, unknown>> {
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
    // Recorded via a CCQA_ASSERT marker on the `get count` probe itself — see
    // `promoteMarkedAssert` — with an `[aria-label=...]` selector that is
    // really asking for the element's accessible name.
    bash(
      "tu_2",
      `CCQA_STEP=step-01 CCQA_ASSERT=element_visible agent-browser --session s1 get count "[aria-label='Category *']"`,
    ),
    text("RUN_COMPLETED|passed|all steps done"),
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

describe("ccqa record — an [aria-label=...] assert is asked of the accessibility tree when the count misses", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("the locator is promoted to role+name from the snapshot, kept (not dropped, not unstable), and reported", async () => {
    project = await makeFakeProject("record-trace-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockAttributeNameTraceMessages());

    const result = await runCcqa(["record", "demo/x"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        // Every `get count` poll misses (0), forcing the fallback to the
        // accessibility snapshot below.
        CCQA_FAKE_AB_COUNT: "0",
        CCQA_FAKE_AB_SNAPSHOT: `- combobox "Category *"`,
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const caseDir = join(project.cwd, ".ccqa/features/demo/test-cases/x");
    const recording = JSON.parse(await readFile(join(caseDir, "ir.json"), "utf8")) as {
      actions: Array<{
        action: string;
        assert?: string;
        locator?: { by: string; value: string; name?: string; exact?: boolean };
        replayUnstable?: boolean;
      }>;
    };
    const ir = recording.actions;
    expect(ir.map((a) => [a.action, a.assert])).toEqual([
      ["navigate", undefined],
      ["assert", "element_visible"],
    ]);
    // Kept — not dropped, not flagged unstable — and holding the role+name
    // form the accessibility tree confirmed, not the CSS selector that
    // counted zero.
    expect(ir[1]!.replayUnstable).toBeFalsy();
    expect(ir[1]!.locator).toEqual({ by: "role", value: "combobox", name: "Category *", exact: true });

    // The promotion is reported by accessible name, not silently applied.
    expect(combined).toContain(
      "locator rewritten to the form that replays: [aria-label='Category *'] names an element rather than an attribute — confirmed as role=combobox",
    );
  }, 120_000);
});

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
    const recording = JSON.parse(await readFile(join(caseDir, "ir.json"), "utf8")) as {
      recordedAt: string;
      origin?: string;
      actions: Array<{
        action: string;
        assert?: string;
        value?: string;
        locator?: { by: string; value: string };
        stepId?: string;
      }>;
    };
    const ir = recording.actions;
    // Provenance: when the route was taken, and the entry point it started from.
    expect(Date.parse(recording.recordedAt)).not.toBeNaN();
    expect(recording.origin).toBe(ir[0]!.value);
    expect(ir.map((a) => [a.action, a.assert, a.stepId])).toEqual([
      ["navigate", undefined, "step-01"],
      ["click", undefined, "step-02"],
      // step-03: promoted from CCQA_ASSERT markers. The marked `wait --text`
      // is REPLACED by its assert (no wait action anywhere), and the `get
      // count` / `get url` probes record only their asserts.
      ["assert", "text_visible", "step-03"],
      ["assert", "element_visible", "step-03"],
      ["assert", "url_contains", "step-03"],
    ]);
    expect(ir[2]!.value).toBe("Ready");
    expect(ir[3]!.locator).toEqual({ by: "css", value: "[data-qa='panel']" });
    expect(ir[4]!.value).toBe("about");

    // The prefixes are trace-time plumbing only — they must never survive
    // into the generated test script, while the promoted asserts must.
    const generated = await readFile(join(caseDir, "test.spec.ts"), "utf8");
    expect(generated).not.toMatch(/CCQA_STEP|CCQA_ASSERT/);
    expect(generated).toMatch(/\/\/ step: step-02/);
    expect(generated).toMatch(/abAssertTextVisible\(/);
    expect(generated).toMatch(/abAssertVisible\(/);
    expect(generated).toMatch(/abAssertUrl\(/);
  }, 120_000);

  // An assertion is what a command performed. A printed one verified nothing,
  // and a recording that looks complete while its checks were dropped is
  // worse than no recording: it would replace one whose checks are real.
  test("a printed assertion is not a check, and the recording it came with is refused", async () => {
    project = await makeFakeProject("record-trace-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    const messages = mockTraceMessages();
    messages.splice(messages.length - 2, 0, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "AB_ACTION|assert|url_contains||about:blank|still there" }],
      },
    });
    await writeMockMessages(mockPath, messages);

    const result = await runCcqa(["record", "demo/x"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        CCQA_FAKE_AB_STDOUT: "about:blank",
        CCQA_FAKE_AB_COUNT: "1",
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(1);
    expect(combined).toContain("printed rather than performed");
    // The kind, not the line: what the model printed is not scrubbed.
    expect(combined).toContain("url_contains");
    expect(combined).not.toContain("still there");
    await expect(
      readFile(join(project.cwd, ".ccqa/features/demo/test-cases/x/ir.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("a trace that finishes FAILED exits 1 and quarantines its actions", async () => {
    project = await makeFakeProject("record-trace-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    const messages = mockTraceMessages();
    // The agent declares the run failed (a step could not complete) — the
    // actions go to ir.failed.json, nothing is generated from them, and the
    // exit code must not paper over the failure.
    messages.splice(messages.length - 1, 0, {
      type: "assistant",
      message: { content: [{ type: "text", text: "RUN_COMPLETED|failed|a step could not complete" }] },
    });
    await writeMockMessages(mockPath, messages);

    const result = await runCcqa(["record", "demo/x"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        CCQA_FAKE_AB_STDOUT: "about:blank",
        CCQA_FAKE_AB_COUNT: "1",
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(1);
    expect(combined).toContain("does not demonstrate the spec");
    // The failed trace's actions land beside the spec, and no test was
    // compiled from them.
    await expect(
      readFile(join(project.cwd, ".ccqa/features/demo/test-cases/x/ir.failed.json"), "utf8"),
    ).resolves.toContain("[");
    await expect(
      readFile(join(project.cwd, ".ccqa/features/demo/test-cases/x/test.spec.ts"), "utf8"),
    ).rejects.toThrow();
  }, 120_000);
});
