import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

export type RunCcqaResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunCcqaOptions = {
  cwd: string;
  env?: Record<string, string>;
  pathPrepend?: string[];
  timeoutMs?: number;
};

// Resolves which binary to invoke for `ccqa`. Controlled by CCQA_CLI env var
// so the same E2E suite can be retargeted across migration phases:
//   Phase 2 (default): "node --experimental-strip-types <repo>/bin/ccqa.ts"
//   Phase 3:           "<repo>/dist/bin/ccqa.js"
function resolveCcqaCommand(): { cmd: string; args: string[] } {
  const override = process.env.CCQA_CLI;
  if (override && override.trim().length > 0) {
    const parts = override.trim().split(/\s+/);
    const [cmd, ...rest] = parts;
    if (!cmd) throw new Error("CCQA_CLI is empty after trim");
    return { cmd, args: rest };
  }
  return {
    cmd: "node",
    args: ["--experimental-strip-types", resolve(REPO_ROOT, "bin", "ccqa.ts")],
  };
}

export function runCcqa(
  args: string[],
  opts: RunCcqaOptions,
): Promise<RunCcqaResult> {
  const { cmd, args: prefixArgs } = resolveCcqaCommand();
  const finalArgs = [...prefixArgs, ...args];

  const baseEnv: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  if (opts.pathPrepend && opts.pathPrepend.length > 0) {
    const sep = process.platform === "win32" ? ";" : ":";
    baseEnv.PATH = [...opts.pathPrepend, baseEnv.PATH ?? ""].join(sep);
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, finalArgs, {
      cwd: opts.cwd,
      env: baseEnv,
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

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runCcqa timed out after ${opts.timeoutMs ?? 60_000}ms`));
    }, opts.timeoutMs ?? 60_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export function getRepoRoot(): string {
  return REPO_ROOT;
}
