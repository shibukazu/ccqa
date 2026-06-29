import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// The fixture's test.spec.ts asserts process.env.CCQA_PROFILE_BASE_URL equals
// the value declared in .ccqa/profiles/stg.env — so the spec only passes when
// `--profile stg` actually merged the profile into the environment.
describe("ccqa run --profile", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("loads .ccqa/profiles/<name>.env into the spec environment", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", "stg"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/profile:\s*stg/);
    expect(combined).toMatch(/1\/1\s+passed/);
  });

  test("fails the spec when no profile supplies the env var", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    // Without the profile the assertion on process.env fails → non-zero exit.
    expect(result.exitCode, combined).not.toBe(0);
  });

  test("exits 2 with a clear error on an unknown profile name", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", "nope"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/profile "nope" not found/);
  });

  test("exits 2 on a path-traversing profile name without reading outside the dir", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", "../../../etc/hosts"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/invalid profile name/);
  });

  test("exits 2 on an explicitly empty profile rather than silently skipping", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", ""], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/invalid profile name/);
  });
});

describe("ccqa run default .env (no --profile)", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
  });

  test("auto-loads <cwd>/.env when no --profile is given", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    // Same var the fixture's test.spec.ts asserts, but supplied via .env, not a profile.
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

  test("does NOT override a var already set in the shell environment", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    // .env sets a different value, but the shell already exports the one the
    // spec asserts — conventional dotenv precedence keeps the shell value.
    await writeFile(
      join(project.cwd, ".env"),
      "CCQA_PROFILE_BASE_URL=https://wrong.example.com\n",
      "utf8",
    );
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: { ...noColorEnv(), CCQA_PROFILE_BASE_URL: "https://stg.example.com" },
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(0);
    expect(combined).toMatch(/1\/1\s+passed/);
  });

  test("runs without complaint when neither --profile nor .env is present", async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke"], {
      cwd: project.cwd,
      env: noColorEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    // passing-spec doesn't depend on any env var, so it passes and no env/profile line is logged.
    expect(result.exitCode, combined).toBe(0);
    expect(combined).not.toMatch(/\[meta\]\s*env:/);
    expect(combined).not.toMatch(/\[meta\]\s*profile:/);
  });
});
