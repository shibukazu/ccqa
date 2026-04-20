import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";

// Smoke-tests that the shebang line in bin/ccqa.ts is honored — i.e. the
// shell can launch the CLI without anyone explicitly prefixing "bun" or
// "node". In Phase 3 this flips to ./dist/bin/ccqa.js and becomes the
// contract test for the packaged artifact.
describe.skipIf(process.platform === "win32")("bin/ccqa shebang", () => {
  test("--version exits 0 and prints a semver", async () => {
    const repoRoot = getRepoRoot();
    const { stdout, exitCode } = await run(`${repoRoot}/bin/ccqa.ts`, ["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
