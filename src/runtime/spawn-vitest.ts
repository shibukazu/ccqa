import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

const require = createRequire(import.meta.url);

// Resolves the absolute path to vitest's bin entry (.mjs). We invoke it via
// `node <path>` so ccqa doesn't need bunx/npx in the user's PATH, and so the
// runtime is always the Node process that started ccqa — no second interpreter.
function resolveVitestBin(): string {
  const pkgPath = require.resolve("vitest/package.json");
  const pkg = require(pkgPath) as { bin?: Record<string, string> | string };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (!binRel) {
    throw new Error(`vitest package.json has no bin entry (resolved at ${pkgPath})`);
  }
  return resolve(dirname(pkgPath), binRel);
}

export type VitestSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type VitestCapturedResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

// Runs vitest and buffers stdout/stderr. Use this when the caller wants the
// full output as a string (e.g. generate/trace pipelines that feed stdout to
// Claude for auto-fix).
export async function spawnVitestCaptured(
  args: readonly string[],
  opts: VitestSpawnOptions = {},
): Promise<VitestCapturedResult> {
  const child = spawnVitestChild(args, opts, "pipe");
  const [stdout, stderr, exitCode] = await Promise.all([
    drain(child.stdout!),
    drain(child.stderr!),
    waitExit(child),
  ]);
  return { exitCode, stdout, stderr };
}

// Runs vitest, tees stdout/stderr to the parent's tty in real time AND
// buffers them so the caller can feed the full transcript to Claude. The
// captured-only variant above is silent until exit, which makes long auto-fix
// runs look hung — prefer this version for any CLI command that wants both.
export async function spawnVitestTeed(
  args: readonly string[],
  opts: VitestSpawnOptions = {},
): Promise<VitestCapturedResult> {
  const child = spawnVitestChild(args, opts, "pipe");
  const [stdout, stderr, exitCode] = await Promise.all([
    teeDrain(child.stdout!, process.stdout),
    teeDrain(child.stderr!, process.stderr),
    waitExit(child),
  ]);
  return { exitCode, stdout, stderr };
}

export type VitestStreamingHandle = {
  child: ChildProcess;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
};

// Runs vitest and exposes stdout/stderr as Readable streams so the caller can
// filter lines as they arrive. Used by `ccqa run` to strip noise lines while
// still echoing output to the user.
export function spawnVitestStreaming(
  args: readonly string[],
  opts: VitestSpawnOptions = {},
): VitestStreamingHandle {
  const child = spawnVitestChild(args, opts, "pipe");
  return {
    child,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exited: waitExit(child),
  };
}

function spawnVitestChild(
  args: readonly string[],
  opts: VitestSpawnOptions,
  stdio: "pipe" | "inherit",
): ChildProcess {
  const vitestBin = resolveVitestBin();
  return spawn(process.execPath, [vitestBin, ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", stdio, stdio],
  });
}

async function drain(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let buf = "";
  for await (const chunk of stream) buf += chunk;
  return buf;
}

async function teeDrain(stream: Readable, sink: NodeJS.WritableStream): Promise<string> {
  stream.setEncoding("utf8");
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    sink.write(chunk);
  }
  return buf;
}

function waitExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("exit", (code) => resolvePromise(code ?? 0));
    child.once("error", rejectPromise);
  });
}
