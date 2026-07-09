import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noAuthEnv, stripAnsi, stubSecurityBinary } from "../_helpers/env.ts";

describe("ccqa run --mode=deterministic --report", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("failing spec: report is written with the failure and a skipped-analysis note; exit code stays vitest's", async () => {
    project = await makeFakeProject("failing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/boom", "--report"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toMatch(/failure analysis skipped/);
    expect(combined).toMatch(/run report \(json\) written to .*ccqa-report\/report\.json/);

    const json = await readFile(join(project.cwd, "ccqa-report", "report.json"), "utf8");
    const data = JSON.parse(json);
    const boom = data.results.find((r: { feature: string; spec: string }) => r.feature === "demo" && r.spec === "boom");
    expect(boom).toBeDefined();
    expect(boom.analysisSkipped).toBeTruthy();
    expect(boom.failureLogExcerpt).toBeTruthy();
  });

  test("passing spec: report is still written as a run summary, without the measurement panel", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--report", "my-report"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);

    const json = await readFile(join(project.cwd, "my-report", "report.json"), "utf8");
    const data = JSON.parse(json);
    const smoke = data.results.find((r: { feature: string; spec: string }) => r.feature === "demo" && r.spec === "smoke");
    expect(smoke).toBeDefined();
    expect(smoke.status).toBe("passed");
    expect(smoke.testCounts.passed).toBe(1);
  });

  test("without --report a report is still written to the default dir", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    expect(result.exitCode).toBe(0);
    // A report is always written now; --report only changes the location.
    const json = await readFile(join(project.cwd, "ccqa-report", "report.json"), "utf8");
    const data = JSON.parse(json);
    const smoke = data.results.find((r: { feature: string; spec: string }) => r.feature === "demo" && r.spec === "smoke");
    expect(smoke).toBeDefined();
    expect(smoke.status).toBe("passed");
  });
});
