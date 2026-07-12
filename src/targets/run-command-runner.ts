import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { getSpecDir, tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import { runPool } from "../runtime/pool.ts";
import { OUTPUT_TAIL_CAP, TailBuffer } from "../run/output-tail.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import type { ReportArtifact, ReportSpecResult } from "../report/schema.ts";
import {
  ARTIFACTS_DIR_ENV,
  collectSpecArtifacts,
  OUTPUT_LOG_FILE,
  specArtifactsDir,
  substituteArtifactsDir,
} from "./run-artifacts.ts";
import type { RunnerOptions, TestRunner } from "./types.ts";
import * as log from "../cli/logger.ts";

/**
 * Substitute `{files}` in a runCommand with the (shell-quoted) cwd-relative
 * test-file paths. Quoting is mandatory: the manifest paths originate from an
 * LLM reply and the command runs through `shell: true`, so an unquoted path
 * containing shell metacharacters would execute as code. A command without
 * the placeholder runs verbatim (it may discover the files itself).
 */
export function substituteRunCommandFiles(runCommand: string, testFiles: string[]): string {
  if (!runCommand.includes("{files}")) return runCommand;
  const joined = testFiles.map(shellQuote).join(" ");
  return runCommand.replaceAll("{files}", joined);
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shared `TestRunner` for external (runCommand) targets: for each spec it
 * reads the `generated.json` manifest that `ccqa generate` left in the spec
 * directory and executes the target's configured `runCommand` with `{files}`
 * expanded to the generated test files. Exit 0 = passed, anything else =
 * failed with the output tail in the report row. Targets whose tests are run
 * by an external tool (Playwright, runn, ...) set this as their `runner`.
 */
export const runCommandRunner: TestRunner = {
  async run(specs: SpecRef[], opts: RunnerOptions): Promise<ReportSpecResult[]> {
    const concurrency = Math.max(1, opts.concurrency);
    // Mirrors the deterministic path: above 1 worker each spec buffers its
    // output (log.withBuffer) and flushes one labelled block on completion.
    return runPool(specs, concurrency, (spec) =>
      log.withBuffer(`${spec.featureName}/${spec.specName}`, concurrency > 1, () =>
        runOneSpec(spec, opts),
      ),
    );
  },
};

/** File `ccqa generate` writes into the spec directory for external targets. */
export const GENERATED_MANIFEST_FILE = "generated.json";

/**
 * Manifest contract shared with the generation side: which files a
 * `ccqa generate` pass wrote (cwd-relative), so `ccqa run` knows what to hand
 * the target's `runCommand`. Only `kind: "test"` entries are executed;
 * "support" files (page objects etc.) ride along for regeneration/drift
 * detection via their hashes.
 */
export const GeneratedManifestSchema = z.object({
  target: z.string(),
  generatedAt: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["test", "support"]),
      sha256: z.string(),
    }),
  ),
});
export type GeneratedManifest = z.infer<typeof GeneratedManifestSchema>;

const ANALYSIS_SKIPPED_EXTERNAL = "failure analysis is not run for external-target specs";

async function runOneSpec(ref: SpecRef, opts: RunnerOptions): Promise<ReportSpecResult> {
  const { featureName, specName } = ref;
  const specYaml = await tryReadSpecFile(featureName, specName, opts.cwd);
  const title = tryParseTestSpec(specYaml)?.title ?? null;
  const failedRow = (detail: string): ReportSpecResult => ({
    ...emptySpecRow({ feature: featureName, spec: specName, title, status: "failed" }),
    target: opts.targetId,
    analysisSkipped: ANALYSIS_SKIPPED_EXTERNAL,
    failureLogExcerpt: detail,
    specYaml,
  });

  const runCommand = opts.targetConfig.runCommand;
  if (runCommand === undefined) {
    // The pipeline only dispatches here when runCommand is set; report a row
    // (not a throw) anyway so a future caller can't crash the whole pool.
    return failedRow(`target "${opts.targetId}" has no runCommand configured in .ccqa/config.yaml`);
  }

  log.run(`${featureName}/${specName}`);

  const manifest = await readGeneratedManifest(ref, opts.cwd);
  if (!manifest.ok) {
    const detail = manifest.missing
      ? `no generated tests for this spec (${manifest.error}) — run 'ccqa generate ${featureName}/${specName}' first`
      : `${manifest.error} — re-run 'ccqa generate ${featureName}/${specName}'`;
    log.error(detail);
    return failedRow(detail);
  }

  const testFiles = manifest.manifest.files.filter((f) => f.kind === "test").map((f) => f.path);
  if (testFiles.length === 0) {
    const detail = `${GENERATED_MANIFEST_FILE} lists no test files — re-run 'ccqa generate ${featureName}/${specName}'`;
    log.error(detail);
    return failedRow(detail);
  }

  // Per-spec artifacts dir, recreated per run so files from a previous run
  // can't leak into this row. `{artifactsDir}` expands to it, and the child
  // always gets it as CCQA_ARTIFACTS_DIR for commands that don't template it.
  const artifactsDir = specArtifactsDir(opts.reportDir, featureName, specName);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  const command = substituteArtifactsDir(
    substituteRunCommandFiles(runCommand, testFiles),
    artifactsDir,
  );
  log.meta("command", command);
  log.blank();

  const started = Date.now();
  let outcome: ShellOutcome;
  try {
    outcome = await runShellCommand(command, {
      cwd: opts.cwd,
      artifactsDir,
      logPath: join(artifactsDir, OUTPUT_LOG_FILE),
    });
  } catch (err) {
    return failedRow(
      `could not spawn runCommand: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const durationMs = Date.now() - started;
  log.blank();

  // Everything the command left in the artifacts dir (plus output.log, always
  // written above) becomes this row's artifacts — passed runs keep their
  // evidence too. Collection is best-effort: an fs error costs the artifacts
  // list, never the run result.
  let artifacts: ReportArtifact[] | undefined;
  try {
    artifacts = await collectSpecArtifacts({
      reportDir: opts.reportDir,
      feature: featureName,
      spec: specName,
      warn: log.warn,
    });
  } catch (err) {
    log.warn(
      `could not collect artifacts for ${featureName}/${specName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const artifactFields = artifacts && artifacts.length > 0 ? { artifacts } : {};

  if (outcome.exitCode === 0) {
    return {
      ...emptySpecRow({ feature: featureName, spec: specName, title, status: "passed" }),
      target: opts.targetId,
      durationMs,
      ...artifactFields,
    };
  }
  const detail = [
    `command failed (exit ${outcome.exitCode}): ${command}`,
    outcome.tail.length > 0 ? `--- output (tail) ---\n${outcome.tail}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join("\n");
  return { ...failedRow(detail), durationMs, ...artifactFields };
}

type ManifestReadResult =
  | { ok: true; manifest: GeneratedManifest }
  | { ok: false; missing: boolean; error: string };

async function readGeneratedManifest(ref: SpecRef, cwd: string): Promise<ManifestReadResult> {
  const path = join(getSpecDir(ref.featureName, ref.specName, cwd), GENERATED_MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, missing: true, error: `${path} not found` };
    }
    return { ok: false, missing: false, error: `${path}: ${(err as Error).message}` };
  }
  try {
    return { ok: true, manifest: GeneratedManifestSchema.parse(JSON.parse(raw)) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      missing: false,
      error: `${path} is not a valid generated-files manifest: ${message}`,
    };
  }
}

type ShellOutcome = { exitCode: number; tail: string };

/**
 * Spawn the user-configured command through the shell (the config value is a
 * full command line, quoting included), streaming output to the logger while
 * keeping a bounded tail for the report row and teeing the full stdout+stderr
 * (shell-transcript style, `$ command` first) into `logPath` so even a passed
 * run's report shows what ran.
 */
async function runShellCommand(
  command: string,
  opts: { cwd: string; artifactsDir: string; logPath: string },
): Promise<ShellOutcome> {
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    // Fresh CCQA_RUN_ID per spec, same contract as the vitest runner: specs
    // that embed `${CCQA_RUN_ID}` in created-content names must not collide
    // across specs or with a prior run.
    env: { ...process.env, [ARTIFACTS_DIR_ENV]: opts.artifactsDir, CCQA_RUN_ID: buildRunId() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = new TailBuffer(OUTPUT_TAIL_CAP);
  // Stream the transcript to a sibling of the artifacts dir, not into it:
  // tools that own that dir may wipe it on startup (e.g. `playwright test
  // --output` recreates its output directory), which would unlink an
  // already-open output.log. The finished transcript moves into place after
  // the child exits (see finally).
  const partialLogPath = `${opts.artifactsDir}.output.log.partial`;
  const logFile = createWriteStream(partialLogPath);
  logFile.write(`$ ${command}\n`);
  const exited = new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("exit", (code, signal) => {
      if (signal) tail.append(`\n[ccqa] command terminated by signal ${signal}\n`);
      resolvePromise(code ?? 1);
    });
    child.once("error", rejectPromise);
  });
  try {
    // Same shape as spawnVitestCaptured: awaiting the exit promise alongside
    // the pumps means a spawn error rejects the whole call instead of leaking
    // an unhandled rejection while the pumps drain.
    const [, , exitCode] = await Promise.all([
      pump(child.stdout!, tail, logFile),
      pump(child.stderr!, tail, logFile),
      exited,
    ]);
    return { exitCode, tail: tail.toString().trim() };
  } finally {
    await new Promise<void>((resolvePromise) => logFile.end(resolvePromise));
    // The child may have deleted (and possibly not recreated) the dir.
    await mkdir(opts.artifactsDir, { recursive: true });
    await rename(partialLogPath, opts.logPath);
  }
}

async function pump(stream: Readable, tail: TailBuffer, logFile: WriteStream): Promise<void> {
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    log.emitRaw(chunk as string);
    tail.append(chunk as string);
    logFile.write(chunk as string);
  }
}
