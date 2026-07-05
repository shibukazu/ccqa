import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";

// --profile now fetches variables from a hub (listVariables) instead of a
// local .ccqa/profiles/<name>.env file. Without --hub-url/--hub-token (or
// CCQA_HUB_URL/CCQA_HUB_TOKEN), any --profile usage fails fast with
// HubConnectionError → exit 2. Explicitly blank out the hub env vars so a
// stray CCQA_HUB_URL/CCQA_HUB_TOKEN in the test runner's own environment
// can't leak into the child process and mask that error.
const noHubEnv = () => ({ ...noColorEnv(), CCQA_HUB_URL: "", CCQA_HUB_TOKEN: "" });

describe("ccqa run --profile", () => {
  let project: FakeProject | null = null;

  afterEach(async () => {
    if (project) {
      await project.cleanup();
      project = null;
    }
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

  test("exits 2 with a clear error when --profile is used without hub connection info", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", "nope"], {
      cwd: project.cwd,
      env: noHubEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/hub URL and token are required/);
  });

  test("exits 2 on an explicitly empty profile (still requires hub connection info)", async () => {
    project = await makeFakeProject("profile-spec", { linkCcqa: true });
    const result = await runCcqa(["run", "demo/smoke", "--profile", ""], {
      cwd: project.cwd,
      env: noHubEnv(),
    });
    const combined = stripAnsi(result.stdout + result.stderr);
    expect(result.exitCode, combined).toBe(2);
    expect(combined).toMatch(/hub URL and token are required/);
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
