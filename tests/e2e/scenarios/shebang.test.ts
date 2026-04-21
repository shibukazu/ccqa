import { spawn } from "node:child_process";
import { accessSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { getRepoRoot } from "../_helpers/cli.ts";

// Contract test for the shipped CLI artifact. dist/bin/ccqa.mjs is emitted
// by `pnpm build` with a #!/usr/bin/env node shebang and chmod 0o755, so
// invoking it directly (no explicit "node" prefix) is the same code path
// a consumer hits after `pnpm add -D ccqa && ./node_modules/.bin/ccqa`.
// Skipped if dist/ is not built yet so the rest of the E2E suite stays
// runnable without a mandatory build step.
const repoRoot = getRepoRoot();
const distBin = `${repoRoot}/dist/bin/ccqa.mjs`;
const distBuilt = (() => {
  try {
    accessSync(distBin);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(process.platform === "win32" || !distBuilt)(
  "bin/ccqa shebang",
  () => {
    test("--version exits 0 and prints a semver", async () => {
      const { stdout, exitCode } = await run(distBin, ["--version"]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  },
);

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
