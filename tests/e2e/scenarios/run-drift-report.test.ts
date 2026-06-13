import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// Forces the Claude-auth probe to fail: empty ANTHROPIC_API_KEY, a HOME
// without ~/.claude/.credentials.json, and (for darwin dev machines) a
// stubbed `security` binary so a real Keychain login can't leak in. The
// report must still be written — only the failure analysis is skipped.
function noAuthEnv(home: string): Record<string, string> {
  return { ...noColorEnv(), ANTHROPIC_API_KEY: "", HOME: home };
}

async function stubSecurityBinary(dir: string): Promise<string> {
  const binDir = join(dir, "stub-bin");
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, "security");
  await writeFile(stub, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(stub, 0o755);
  return binDir;
}

describe("ccqa run --drift-report", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("failing spec: report is written with the failure and a skipped-analysis note; exit code stays vitest's", async () => {
    project = await makeFakeProject("failing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/boom", "--drift-report"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toMatch(/failure analysis skipped/);
    expect(combined).toMatch(/run report written to ccqa-report/);

    const html = await readFile(join(project.cwd, "ccqa-report", "index.html"), "utf8");
    expect(html).toContain("demo/boom");
    expect(html).toContain("analysis skipped");
    expect(html).toContain("Failure log");
  });

  test("passing spec: report is still written as a run summary, without the measurement panel", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--drift-report", "my-report"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const html = await readFile(join(project.cwd, "my-report", "index.html"), "utf8");
    expect(html).toContain("demo/smoke");
    expect(html).toContain("1 passed");
    expect(html).not.toContain('id="measure-panel"');
  });

  test("without --drift-report no report directory is created", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    expect(result.exitCode).toBe(0);
    await expect(
      readFile(join(project.cwd, "ccqa-report", "index.html"), "utf8"),
    ).rejects.toThrow();
  });
});
