import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// End-to-end for `--on-fail-explain-rerun`, on the one property no unit test
// can hold: the spec really is executed a second time, and the run stays red
// when that attempt passes. Claude is mocked so the classification is fixed
// (UNKNOWN) and the rerun is the only thing under test.

const git = promisify(execFile);

const UNKNOWN_ANALYSIS = JSON.stringify({
  label: "UNKNOWN",
  confidence: 0.2,
  headline: "cannot tell from this evidence",
  recommendation: "look at it by hand",
  evidence: [{ detail: "the log stops mid-step" }],
  reasoning: "nothing in the diff explains it",
});

/** A spec that fails the first time it runs and passes the second — a flake, on demand. */
const FLAKY_SPEC = `import { existsSync, writeFileSync } from "node:fs";
import { test, expect } from "vitest";

test("passes only on a second attempt", () => {
  const marker = process.env.CCQA_FLAKE_MARKER;
  const seen = existsSync(marker);
  writeFileSync(marker, "x");
  expect(seen).toBe(true);
});
`;

describe("ccqa run --on-fail-explain-rerun", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("a rerun that passes labels the row ENVIRONMENT and leaves the run red", async () => {
    project = await makeFakeProject("failing-spec", { linkCcqa: true });
    const cwd = project.cwd;
    await writeFile(
      join(cwd, ".ccqa/features/demo/test-cases/boom/test.spec.ts"),
      FLAKY_SPEC,
      "utf8",
    );
    // --on-fail-explain-base needs a resolvable commit.
    await git("git", ["init", "-q"], { cwd });
    await git("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "x", "--allow-empty"], { cwd });
    const mockPath = join(cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      { type: "result", subtype: "success", result: UNKNOWN_ANALYSIS, is_error: false },
    ]);

    const result = await runCcqa(
      ["run", "demo/boom", "--on-fail-explain", "--on-fail-explain-base", "HEAD", "--on-fail-explain-rerun", "auto"],
      {
        cwd,
        env: {
          ...noColorEnv(),
          ANTHROPIC_API_KEY: "test-key",
          CCQA_CLAUDE_MOCK_FILE: mockPath,
          CCQA_FLAKE_MARKER: join(cwd, "flake-marker"),
        },
        timeoutMs: 120_000,
      },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    // The spec failed, so the run is red however the second attempt went.
    expect(result.exitCode, combined).toBe(1);
    expect(combined).toContain("did not reproduce");

    const data = JSON.parse(await readFile(join(cwd, "ccqa-report", "report.json"), "utf8"));
    const row = data.results.find((r: { spec: string }) => r.spec === "boom");
    expect(row.status).toBe("failed");
    expect(row.rerun).toEqual({ outcome: "passed" });
    expect(row.analysis.label).toBe("ENVIRONMENT");
  });
});
