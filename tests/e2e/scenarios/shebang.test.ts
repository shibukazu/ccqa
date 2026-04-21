import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";

// Phase 2: the shebang in bin/ccqa.ts is `#!/usr/bin/env node`, but the file
// is still .ts, so Node cannot execute it via the shebang without the type-
// stripping flag. We therefore invoke it explicitly as
// `node --experimental-strip-types ./bin/ccqa.ts` here. Phase 3 will emit
// `dist/bin/ccqa.js` (plain JS) and flip this test to target that file via
// the shebang directly.
describe.skipIf(process.platform === "win32")("bin/ccqa invocation", () => {
  test("--version exits 0 and prints a semver", async () => {
    const repoRoot = getRepoRoot();
    const { stdout, exitCode } = await run("node", [
      "--experimental-strip-types",
      `${repoRoot}/bin/ccqa.ts`,
      "--version",
    ]);
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
