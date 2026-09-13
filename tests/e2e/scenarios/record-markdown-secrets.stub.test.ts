import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

/**
 * `ccqa record` of a markdown case whose credentials come from the project's
 * own env file — the shape that put a password in `ir.json`.
 *
 * Everything here is one recording, because the failures were one recording:
 * the values reached the route, the replay could not find the fields the
 * recorder said it used, and the generated test's cleanup ran for attempts
 * that had created nothing. Claude and agent-browser are both faked, so this
 * asserts the wiring and never the quality of a recording.
 */
const EMAIL = "analyst@example.test";
const PASSWORD = "correct-horse-battery";
/** A password typed literally rather than read from a variable — never recorded. */
const HAND_TYPED = "hunter2-typed-by-hand";

function mockTrace(): Array<Record<string, unknown>> {
  const bash = (id: string, command: string): Record<string, unknown> => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
  });
  const s = "agent-browser --session s1";
  return [
    bash("t1", `CCQA_STEP=step-01 ${s} open "https://example.test/sign-in"`),
    // Recorded by label, which the sign-in form does not associate with its
    // inputs: the replay's fallback is what has to rescue these.
    bash("t2", `CCQA_STEP=step-02 ${s} find label "Email" fill "${EMAIL}"`),
    bash("t3", `CCQA_STEP=step-03 CCQA_SECRET=1 ${s} find label "Password" fill "${HAND_TYPED}"`),
    bash("t4", `CCQA_STEP=step-03 CCQA_SECRET=1 ${s} find label "Password" fill "${PASSWORD}"`),
    bash("t5", `CCQA_STEP=step-03 ${s} find role button click --name "Sign in"`),
    bash("t6", `CCQA_STEP=step-04 ${s} fill "[data-testid='note-title']" "note \${CCQA_RUN_ID}"`),
    bash("t7", `CCQA_STEP=step-04 ${s} find role button click --name "Create"`),
    bash("t8", `CCQA_STEP=step-05 CCQA_ASSERT=1 ${s} wait --text "note \${CCQA_RUN_ID}"`),
    bash("t9", `CCQA_STEP=cleanup-01 ${s} find role button click --name "Delete"`),
    bash(
      "t10",
      `CCQA_STEP=cleanup-01 CCQA_ASSERT=element_not_visible ${s} get count "text=note \${CCQA_RUN_ID}"`,
    ),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "RUN_COMPLETED|passed|every step verified" }] },
    },
    { type: "result", subtype: "success", result: "", is_error: false },
  ];
}

interface Ir {
  actions: Array<{
    action: string;
    value?: string;
    locator?: { by: string; value: string; name?: string; exact?: boolean };
    stepId?: string;
    secret?: boolean;
  }>;
  cleanup?: Ir["actions"];
}

describe("ccqa record — a markdown case whose credentials come from envFiles", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) await project.cleanup();
    project = null;
  });

  test("keeps the variables, drops the typed password, and repairs the locators", async () => {
    project = await makeFakeProject("external-secrets", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockTrace());

    const result = await runCcqa(["record", "account/sign_in", "--auto-fix", "skip"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        // The form has no label association, so addressing by label misses and
        // addressing by accessible name hits.
        CCQA_FAKE_AB_FAIL_ARG: "label",
        CCQA_FAKE_AB_COUNT: "1",
      },
      timeoutMs: 120_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const caseDir = join(project.cwd, ".ccqa/cases/account/sign_in");
    const ir = JSON.parse(await readFile(join(caseDir, "ir.json"), "utf8")) as Ir;

    // 1. The route carries the references, never what they resolved to.
    const irText = JSON.stringify(ir);
    expect(irText).not.toContain(EMAIL);
    expect(irText).not.toContain(PASSWORD);
    expect(irText).toContain("${TEST_EMAIL}");
    expect(irText).toContain("${TEST_PASSWORD}");

    // 2. A password typed literally is not written anywhere under .ccqa.
    expect(await grepUnder(join(project.cwd, ".ccqa"), HAND_TYPED)).toEqual([]);
    expect(combined).toContain("password field");

    // 3. The label the form never associated is replaced by the form that
    // replays, so the next `ccqa generate` does not send this case back.
    const email = ir.actions.find((a) => a.value === "${TEST_EMAIL}")!;
    expect(email.locator).toEqual({ by: "role", value: "textbox", name: "Email", exact: true });
    expect(combined).toContain("locator rewritten");
  }, 180_000);

  test("the generated test cites the case and guards its cleanup by what it created", async () => {
    project = await makeFakeProject("external-secrets", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockTrace());

    const result = await runCcqa(["record", "account/sign_in", "--auto-fix", "skip"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        CCQA_FAKE_AB_FAIL_ARG: "label",
        CCQA_FAKE_AB_COUNT: "1",
      },
      timeoutMs: 120_000,
    });
    expect(result.exitCode, stripAnsi(result.stdout + result.stderr)).toBe(0);

    const generated = await readFile(
      join(project.cwd, "specs/account/sign_in.spec.ts"),
      "utf8",
    );
    // The comment a reviewer reads against the case's own numbered list.
    expect(generated).toContain("// step 1: Open the sign-in page");
    expect(generated).toContain("// cleanup 1: Delete the created note");
    // The project's own helper, and the guard assigned where the note was made.
    expect(generated).toContain("uniqueValue = runId();");
    expect(generated).toContain("if (!createdSomething) return;");
    const body = generated.split("\n").map((l) => l.trim());
    expect(body.indexOf("createdSomething = true;")).toBe(
      body.findIndex((l) => l.includes(`name: "Create"`)) + 1,
    );
    expect(generated).not.toContain(EMAIL);
    expect(generated).not.toContain(PASSWORD);

    // The verification run's own step evidence, kept for the review table.
    const evidence = await runCcqa(["evidence", "account/sign_in"], {
      cwd: project.cwd,
      env: noColorEnv(),
      timeoutMs: 60_000,
    });
    expect(evidence.exitCode, stripAnsi(evidence.stdout + evidence.stderr)).toBe(0);
    const table = await readFile(join(project.cwd, ".ccqa/cases/account/sign_in/evidence.md"), "utf8");
    expect(table).toMatch(/!\[step-01\]\(evidence\//);
    expect(table).not.toContain(EMAIL);
    expect(table).not.toContain(PASSWORD);
  }, 180_000);

  // The table is written to be pasted into a pull request, and a route
  // recorded before this project named its env files still holds the values.
  test("the review table symbolises a value a saved route still holds", async () => {
    project = await makeFakeProject("external-secrets", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);
    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, mockTrace());

    const env = {
      ...noColorEnv(),
      CCQA_CLAUDE_MOCK_FILE: mockPath,
      CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
      CCQA_FAKE_AB_FAIL_ARG: "label",
      CCQA_FAKE_AB_COUNT: "1",
    };
    await runCcqa(["record", "account/sign_in", "--auto-fix", "skip"], {
      cwd: project.cwd,
      env,
      timeoutMs: 120_000,
    });

    // A route from before the scrub existed: the value, not the reference.
    const irPath = join(project.cwd, ".ccqa/cases/account/sign_in/ir.json");
    const ir = (await readFile(irPath, "utf8")).replaceAll("${TEST_EMAIL}", EMAIL);
    await writeFile(irPath, ir, "utf8");

    await runCcqa(["evidence", "account/sign_in"], {
      cwd: project.cwd,
      env: noColorEnv(),
      timeoutMs: 60_000,
    });
    const table = await readFile(join(project.cwd, ".ccqa/cases/account/sign_in/evidence.md"), "utf8");
    expect(table).not.toContain(EMAIL);
    expect(table).toContain("${TEST_EMAIL}");
  }, 180_000);
});

/** Every file under `dir` whose bytes contain `needle`. */
async function grepUnder(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const abs = join(at, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if ((await readFile(abs, "utf8").catch(() => "")).includes(needle)) hits.push(abs);
    }
  };
  await walk(dir);
  return hits;
}
