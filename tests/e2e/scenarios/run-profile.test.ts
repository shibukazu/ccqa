import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noAuthEnv, noColorEnv, stripAnsi, stubSecurityBinary } from "../_helpers/env.ts";

// These two tests cover the real subprocess env injection that unit tests can't
// reach: a var supplied (or missing) at the CLI must land in the spawned vitest
// process.env the spec reads. The pure logic around --profile — exit(2) when
// hub connection info is missing, and dotenv precedence (shell wins) — is
// already unit-tested (src/cli/options.test.ts, src/runtime/profile-env.test.ts).
describe("ccqa run env injection", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("fails the spec when no profile or .env supplies the env var", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    // The spec fails (missing env var), which now triggers failure analysis
    // since a report is always written; force the auth probe to fail so it's
    // skipped (no real Claude call that would hang this test).
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    // Without the var the assertion on process.env fails → non-zero exit.
    expect(result.exitCode, combined).not.toBe(0);
  });

  test("auto-loads <cwd>/.env so the var reaches the spawned spec", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    // The same var the fixture's test.spec.ts asserts, supplied via .env.
    await writeFile(
      join(project.cwd, ".env"),
      "CCQA_PROFILE_BASE_URL=https://stg.example.com\n",
      "utf8",
    );
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/env:\s*\.env/);
    expect(combined).toMatch(/1\/1\s+passed/);
  });
});
