import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export interface CcqaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCcqaOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Ambient configuration that must not leak into an eval run: a developer's
 * hub connection would pull project guidance into the prompts under test,
 * and CCQA_MODEL would override the model the results file claims was used.
 */
const SCRUBBED_ENV_KEYS = ["CCQA_HUB_URL", "CCQA_HUB_TOKEN", "CCQA_HUB_HEADER", "CCQA_MODEL"];

/**
 * Run this working tree's ccqa via the dev entry (`bin/ccqa.ts`), which is
 * the point of the harness: edit a prompt under `src/`, re-run, compare — no
 * build in between.
 */
export function runCcqa(args: string[], opts: RunCcqaOptions): Promise<CcqaResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  Object.assign(env, opts.env);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "node",
      ["--experimental-strip-types", resolve(REPO_ROOT, "bin", "ccqa.ts"), ...args],
      { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ccqa ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

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
