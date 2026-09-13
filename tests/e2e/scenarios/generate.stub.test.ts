import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";

// CCQA_CLAUDE_MOCK_FILE lets us replace the Claude Agent SDK with a JSONL
// replay. The CLI's cleanupActions() only cares about the message whose
// `type` is "result" and `subtype` is "success" — it reads `.result` and
// tries to JSON-parse it. Returning an empty string is the "no cleanup
// suggested" signal, in which case the pipeline keeps the original actions.
const MOCK_NOOP_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "",
  is_error: false,
});

describe("ccqa generate — mocked Claude (codegen-only flow)", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("generates test.spec.ts from ir.json using a JSONL-replayed Claude", async () => {
    project = await makeFakeProject("generate-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeFile(mockPath, MOCK_NOOP_RESULT + "\n", "utf8");

    const result = await runCcqa(["generate", "demo/x"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_CLAUDE_MOCK_FILE: mockPath },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const scriptPath = join(
      project.cwd,
      ".ccqa/features/demo/test-cases/x/test.spec.ts",
    );
    const generated = await readFile(scriptPath, "utf8");
    expect(generated).toMatch(/import { ab[^}]*} from "ccqa\/test-helpers"/);
    expect(generated).toMatch(/ab\("open", "about:blank"\)/);
  });

  // A route that fills a title with `${CCQA_RUN_ID}` and later asserts it back
  // used to have that fill skipped, so the form went in empty and the assertion
  // could never pass — a live route read as dead.
  test("the replay gate resolves ${CCQA_RUN_ID} to one value the whole route shares", async () => {
    project = await makeFakeProject("generate-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeFile(mockPath, MOCK_NOOP_RESULT + "\n", "utf8");
    const logPath = join(project.cwd, "ab.log");

    const result = await runCcqa(["generate", "demo/run-id"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        // Every agent-browser call, the gate's own probes included, goes to the
        // fake rather than whatever binary this machine has installed.
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        CCQA_FAKE_AB_LOG: logPath,
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const logLines = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    // The gate's probes carry `--session <name>-regen`; the generated test's
    // own run addresses agent-browser directly, which tells the two apart.
    const gateCalls = logLines.filter((argv) => argv[0] === "--session");

    const filled = gateCalls.find((argv) => argv.includes("fill") && argv.includes("#title"));
    expect(filled, JSON.stringify(gateCalls)).toBeDefined();
    // The value is the last token; an earlier one is the session name, which
    // also happens to start with "ccqa-".
    const runIdValue = filled!.at(-1);
    expect(runIdValue, JSON.stringify(filled)).toBeDefined();
    // Resolved, and to something real: the literal placeholder and an empty
    // fallback would both make fill/wait/cleanup agree with each other.
    expect(runIdValue).not.toContain("${CCQA_RUN_ID}");
    expect(runIdValue).toMatch(/^ccqa-\S{8,}$/);

    const waited = gateCalls.find((argv) => argv.includes("--text") && argv.includes(runIdValue!));
    expect(waited, JSON.stringify(gateCalls)).toBeDefined();

    const cleaned = gateCalls.find(
      (argv) => argv.includes("#cleanup-note") && argv.includes(runIdValue!),
    );
    expect(cleaned, JSON.stringify(gateCalls)).toBeDefined();

    const irPath = join(project.cwd, ".ccqa/features/demo/test-cases/run-id/ir.json");
    const irAfter = JSON.parse(await readFile(irPath, "utf8"));
    expect(irAfter.actions.map((a: { value?: string }) => a.value)).toContain(
      "ccqa-${CCQA_RUN_ID}",
    );
    expect(irAfter.cleanup[0].value).toBe("ccqa-${CCQA_RUN_ID}");
  }, 120_000);

  // A cleanup locator is rarely scoped to the run id, so replaying the undo of
  // a route that created nothing removes whatever was already there.
  test("a route that does not replay whole leaves its recorded cleanup alone", async () => {
    project = await makeFakeProject("generate-stub", { linkCcqa: true });
    await installFakeAgentBrowser(project.cwd);

    const mockPath = join(project.cwd, "claude-mock.jsonl");
    await writeFile(mockPath, MOCK_NOOP_RESULT + "\n", "utf8");
    const logPath = join(project.cwd, "ab.log");

    const result = await runCcqa(["generate", "demo/run-id"], {
      cwd: project.cwd,
      env: {
        ...noColorEnv(),
        CCQA_CLAUDE_MOCK_FILE: mockPath,
        CCQA_AB_BIN: join(project.cwd, "node_modules/agent-browser/bin/agent-browser.js"),
        CCQA_FAKE_AB_LOG: logPath,
        CCQA_FAKE_AB_FAIL_ARG: "#title",
      },
      timeoutMs: 90_000,
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toContain("the recorded route no longer replays");
    expect(combined).toContain("The recorded cleanup was not attempted");

    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("#cleanup-note");
  }, 120_000);
});
