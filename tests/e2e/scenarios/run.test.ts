import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noAuthEnv, noColorEnv, stripAnsi, stubSecurityBinary } from "../_helpers/env.ts";

async function addSpec(cwd: string, feature: string, spec: string, body: string): Promise<void> {
  const dir = join(cwd, ".ccqa", "features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "test.spec.ts"), body, "utf8");
  // spec.yaml is the source of truth for spec discovery (`mode:` resolution
  // happens here). Write a minimal one so listAllSpecsWithSpecFile picks it up.
  await writeFile(
    join(dir, "spec.yaml"),
    `title: ${feature}/${spec}\nsteps:\n  - instruction: noop\n    expected: noop\n`,
    "utf8",
  );
}

describe("ccqa run", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("passes with exit 0 on a trivially passing spec", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/1\/1\s+passed/);
  });

  test("renders a failing spec and a stable pass/fail summary", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    // Add a failing spec alongside the passing one so both halves of the
    // summary (passed + failed counts) render.
    await addSpec(
      project.cwd,
      "demo",
      "boom",
      `import { test, expect } from "vitest";\ntest("fail", () => { expect(1).toBe(2); });\n`,
    );
    // A report is always written now, so the failing spec triggers failure
    // analysis. Force the auth probe to fail so it's skipped (no real Claude
    // call) — this test asserts run behaviour, not analysis.
    const result = await runCcqa(["run"], {
      cwd: project.cwd,
      env: noAuthEnv(project.cwd),
      pathPrepend: [await stubSecurityBinary(project.cwd)],
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).not.toBe(0);
    expect(combined).toMatch(/demo\/boom/);
    expect(combined).toMatch(/1\s+failed/);
    // Summary format is stable: banner + aggregate counts (both halves) + rows.
    expect(combined).toMatch(/──────── ccqa summary ────────/);
    expect(combined).toMatch(/Specs\s+\d+\s+\(\d+ passed, \d+ failed\)/);
    expect(combined).toMatch(/Tests\s+\d+\s+\(\d+ passed, \d+ failed, \d+ skipped\)/);
    expect(combined).toMatch(/demo\/smoke\s+\d+\/\d+\s+passed/);
  });

  test("runs multiple targets in parallel with --concurrency 2", async () => {
    project = await makeFakeProject("multi-spec", { linkCcqa: true });
    const result = await runCcqa(
      ["run", "alpha/one", "beta/two", "--concurrency", "2"],
      { cwd: project.cwd, env: noColorEnv() },
    );
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/2 targets/);
    expect(combined).toMatch(/2 passed/);
    // Per-spec blocks flush in completion order (non-deterministic), but the
    // summary is rendered from the input-ordered result list, so within it
    // alpha precedes beta regardless of which finished first.
    const summary = combined.slice(combined.indexOf("ccqa summary"));
    expect(summary.indexOf("alpha/one")).toBeGreaterThanOrEqual(0);
    expect(summary.indexOf("alpha/one")).toBeLessThan(summary.indexOf("beta/two"));
    expect(combined).toMatch(/Specs\s+2\s+\(2 passed/);
  });

  test("de-dupes repeated and overlapping targets", async () => {
    project = await makeFakeProject("multi-spec", { linkCcqa: true });
    // alpha (whole feature) + alpha/one (same spec) → alpha/one runs once.
    const result = await runCcqa(["run", "alpha", "alpha/one"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/Specs\s+1\s+\(1 passed/);
    const occurrences = combined.match(/✔ alpha\/one/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  test("rejects --concurrency combined with multiple targets and --changed", async () => {
    project = await makeFakeProject("multi-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "alpha/one", "beta/two", "--changed"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/--changed and an explicit spec target cannot be combined/);
  });

  test("rejects a non-positive --concurrency with exit 2", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--concurrency", "0"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/invalid --concurrency/);
  });
});
