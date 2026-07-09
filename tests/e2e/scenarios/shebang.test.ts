import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";
import { makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { installFakeAgentBrowser } from "../_helpers/fake-ab.ts";

// Contract test for the shipped CLI artifact. dist/bin/ccqa.mjs is emitted by
// `pnpm build` with a #!/usr/bin/env node shebang and chmod 0o755, so invoking
// it directly (no explicit "node" prefix) is the same code path a consumer hits
// after `pnpm add -D ccqa && ./node_modules/.bin/ccqa`. This is the only E2E
// that exercises the built artifact (the pack→install smoke was dropped for
// being slow and flaky), so it must stay meaningful.
//
// Normally skipped when dist/ isn't built so the rest of the E2E suite runs
// without a mandatory build. In CI, set CCQA_REQUIRE_DIST=1 (after `pnpm
// build`) so a missing/broken dist/ FAILS here instead of silently skipping.
const repoRoot = getRepoRoot();
const distBin = `${repoRoot}/dist/bin/ccqa.mjs`;
const requireDist = process.env.CCQA_REQUIRE_DIST === "1";
const distBuilt = (() => {
  try {
    accessSync(distBin);
    return true;
  } catch {
    return false;
  }
})();

if (requireDist && !distBuilt) {
  throw new Error(
    `CCQA_REQUIRE_DIST=1 but ${distBin} is missing — run \`pnpm build\` before the E2E suite`,
  );
}

describe.skipIf(process.platform === "win32" || !distBuilt)(
  "dist/bin/ccqa artifact",
  () => {
    let project: FakeProject | null = null;

    afterEach(async () => {
      if (project) {
        await project.cleanup();
        project = null;
      }
    });

    test("--version exits 0 and prints a semver (shebang is honored)", async () => {
      const { stdout, exitCode } = await run(distBin, ["--version"]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("runs a spec end-to-end when invoked directly", async () => {
      // Drive the built artifact against a real project so the shipped bundle's
      // run path (not just --version) is covered — the smoke the pack→install
      // test used to guard, minus the flaky packaging step.
      project = await makeFakeProject("passing-spec", { linkCcqa: true });
      const { stdout, stderr, exitCode } = await run(distBin, ["run", "demo/smoke"], project.cwd);
      const combined = stripAnsi(stdout + stderr);
      expect(exitCode, combined).toBe(0);
      expect(combined).toMatch(/1\/1\s+passed/);
    });

    test("a spec importing 'ccqa/test-helpers' resolves against the published dist exports", async () => {
      // A consumer's `import { ab } from "ccqa/test-helpers"` only resolves if
      // the published exports["./test-helpers"] points at a real built file
      // (import condition, .mjs, dist path). ccqaTarget:"dist" keeps the real
      // exports and ships the built dist/, so running the spec through the
      // built CLI exercises that exact resolution — if the build stops emitting
      // it, this fails here instead of only in a downstream consumer. Replaces
      // the dropped pack→install smoke.
      project = await makeFakeProject("with-test-helpers", {
        linkCcqa: true,
        ccqaTarget: "dist",
      });
      await installFakeAgentBrowser(project.cwd);
      const { stdout, stderr, exitCode } = await run(distBin, ["run", "demo/helper-smoke"], project.cwd);
      const combined = stripAnsi(stdout + stderr);
      expect(exitCode, combined).toBe(0);
      expect(combined).toMatch(/1\/1\s+passed/);
    });
  },
);

function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...noColorEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 }),
    );
  });
}
