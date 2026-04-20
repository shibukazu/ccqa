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

describe("ccqa generate — mocked Claude", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("generates test.spec.ts from actions.json using a JSONL-replayed Claude", async () => {
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
});
