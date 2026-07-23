import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { getSpecDir, loadAllBlocks, tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import type { BlockSpec } from "../types.ts";
import { runPool } from "../runtime/pool.ts";
import { OUTPUT_TAIL_CAP, TailBuffer } from "../run/output-tail.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import {
  buildStepDescriptions,
  loadEvidenceForSpec,
  specEvidenceDir,
} from "../report/evidence.ts";
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
    // Blocks are only needed for step-evidence captions, and only when the
    // target captures evidence — load them once for the whole group, not once
    // per spec.
    const blocks: Map<string, BlockSpec> = opts.stepEvidence.supported
      ? await loadAllBlocks(opts.cwd)
      : new Map();
    // Mirrors the deterministic path: above 1 worker each spec buffers its
    // output (log.withBuffer) and flushes one labelled block on completion.
    // runPool preserves input order, so the returned rows drive report.json's
    // stable spec order; onSpecComplete is the separate, as-it-finishes channel
    // used only for incremental hub push / interrupt safety.
    //
    // A worker must NEVER throw. runPool rejects the whole pool on the first
    // worker throw while sibling workers keep running detached — and since each
    // worker upserts its row via onSpecComplete, a straggler finishing after
    // the reject would race (and clobber) the final report write. So convert an
    // unexpected throw — from runOneSpec or from the onSpecComplete push — into
    // this spec's own failed row instead of letting it escape.
    return runPool(specs, concurrency, async (spec) => {
      const key = `${spec.featureName}/${spec.specName}`;
      let row: ReportSpecResult;
      try {
        row = await log.withBuffer(key, concurrency > 1, () => runOneSpec(spec, opts, blocks));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${key}: runner error: ${message}`);
        row = {
          ...emptySpecRow({ feature: spec.featureName, spec: spec.specName, title: null, status: "failed" }),
          target: opts.targetId,
          analysisSkipped: "spec did not execute (runner error)",
          failureLogExcerpt: `runner error for ${key}: ${message}`,
        };
      }
      // Hand the row over the moment it exists — an interrupt mid-group must
      // not cost the specs that already finished. Best-effort and guarded so a
      // push failure can't reject the worker (which would reintroduce the
      // straggler race). Outside the buffered scope so a hub-push warning isn't
      // swallowed into the spec's log block.
      try {
        await opts.onSpecComplete(row);
      } catch (err) {
        log.warn(`${key}: could not report row incrementally: ${err instanceof Error ? err.message : String(err)}`);
      }
      return row;
    });
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

/**
 * Hex sha256 of a manifest file's content — the one hash both the generation
 * side (writes `files[].sha256`) and the run side (checks it, see
 * `warnDriftedFiles`) must compute identically. A string is hashed as UTF-8,
 * matching how the file is written to disk.
 */
export function manifestSha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function runOneSpec(
  ref: SpecRef,
  opts: RunnerOptions,
  blocks: Map<string, BlockSpec>,
): Promise<ReportSpecResult> {
  const { featureName, specName } = ref;
  const specYaml = await tryReadSpecFile(featureName, specName, opts.cwd);
  const parsedSpec = tryParseTestSpec(specYaml);
  const title = parsedSpec?.title ?? null;
  const failedRow = (detail: string): ReportSpecResult => ({
    ...emptySpecRow({ feature: featureName, spec: specName, title, status: "failed" }),
    target: opts.targetId,
    failureLogExcerpt: detail,
    specYaml,
  });
  /**
   * A failure from *before* the test ever ran (nothing generated, nothing
   * spawnable). Classifying these would feed the model an empty script and a
   * log that says "run `ccqa generate` first", and the junk label it returns
   * would land in the confusion matrix and the project's learned prompt — so
   * the row states the real reason instead and the classifier skips it.
   */
  const didNotExecute = (detail: string, why: string): ReportSpecResult => ({
    ...failedRow(detail),
    analysisSkipped: `spec did not execute (${why})`,
  });

  const runCommand = opts.targetConfig.runCommand;
  if (runCommand === undefined) {
    // The pipeline only dispatches here when runCommand is set; report a row
    // (not a throw) anyway so a future caller can't crash the whole pool.
    return didNotExecute(
      `target "${opts.targetId}" has no runCommand configured in .ccqa/config.yaml`,
      "the target has no runCommand",
    );
  }

  log.run(`${featureName}/${specName}`);

  const manifest = await readGeneratedManifest(ref, opts.cwd);
  if (!manifest.ok) {
    const detail = manifest.missing
      ? `no generated tests for this spec (${manifest.error}) — run 'ccqa generate ${featureName}/${specName}' first`
      : `${manifest.error} — re-run 'ccqa generate ${featureName}/${specName}'`;
    log.error(detail);
    return didNotExecute(detail, "no generated tests");
  }

  const testFiles = manifest.manifest.files.filter((f) => f.kind === "test").map((f) => f.path);
  if (testFiles.length === 0) {
    const detail = `${GENERATED_MANIFEST_FILE} lists no test files — re-run 'ccqa generate ${featureName}/${specName}'`;
    log.error(detail);
    return didNotExecute(detail, "no generated tests");
  }

  // Generated files aren't meant to be hand-edited; warn (never fail) when one
  // drifts from the sha256 the manifest recorded, so a stale/edited test is
  // visible in the log instead of silently running. Advisory and read-only, so
  // it runs alongside the command (no data dependency) and is awaited before
  // the row is built.
  const driftWarn = warnDriftedFiles(ref, manifest.manifest, opts.cwd);

  // Per-spec artifacts dir, recreated per run so files from a previous run
  // can't leak into this row. `{artifactsDir}` expands to it, and the child
  // always gets it as CCQA_ARTIFACTS_DIR for commands that don't template it.
  const artifactsDir = specArtifactsDir(opts.reportDir, featureName, specName);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  // Step screenshots go to the same per-spec directory the deterministic path
  // uses, so one loader serves both. Only targets whose generated tests call
  // `ccqa/step-evidence` get it — for the rest the var stays unset and the
  // capture helper (or its absence) is a no-op.
  const evidenceDir = opts.stepEvidence.supported
    ? specEvidenceDir(opts.reportDir, featureName, specName)
    : null;
  if (evidenceDir) {
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(evidenceDir, { recursive: true });
  }

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
      evidenceDir,
      logPath: join(artifactsDir, OUTPUT_LOG_FILE),
    });
  } catch (err) {
    return didNotExecute(
      `could not spawn runCommand: ${err instanceof Error ? err.message : String(err)}`,
      "the runCommand could not be spawned",
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
  const evidenceFields = await loadStepEvidence(opts, evidenceDir, parsedSpec, blocks);
  await driftWarn; // ensure the advisory warning lands inside this spec's log block

  if (outcome.exitCode === 0) {
    return {
      ...emptySpecRow({ feature: featureName, spec: specName, title, status: "passed" }),
      target: opts.targetId,
      durationMs,
      ...artifactFields,
      ...evidenceFields,
    };
  }
  const detail = [
    `command failed (exit ${outcome.exitCode}): ${command}`,
    outcome.tail.length > 0 ? `--- output (tail) ---\n${outcome.tail}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join("\n");
  return { ...failedRow(detail), durationMs, ...artifactFields, ...evidenceFields };
}

/**
 * The row's step screenshots, or — when there are none — the reason, so the
 * report never shows an empty evidence section without explanation. A
 * supported target that produced nothing almost always means the generated
 * test lost its capture calls (a library-rewrite pass dropping them is the
 * known hazard), which is worth saying out loud.
 */
async function loadStepEvidence(
  opts: RunnerOptions,
  evidenceDir: string | null,
  spec: TestSpec | null,
  blocks: Map<string, BlockSpec>,
): Promise<Pick<ReportSpecResult, "evidence" | "evidenceUnavailable">> {
  if (!opts.stepEvidence.supported) {
    return { evidence: null, evidenceUnavailable: opts.stepEvidence.reason };
  }
  const descriptions = buildStepDescriptions(spec, blocks);
  const evidence = await loadEvidenceForSpec(evidenceDir, opts.reportDir, descriptions);
  if (evidence) return { evidence };
  return {
    evidence: null,
    evidenceUnavailable:
      "no step screenshots were captured — the generated test may be missing its " +
      "ccqa/step-evidence calls; re-run `ccqa generate` for this spec",
  };
}

/**
 * Warn (never fail) when a generated file's current sha256 differs from the
 * one `generated.json` recorded — the generated tree is not meant to be
 * hand-edited, so a mismatch means the running test no longer matches what
 * `ccqa generate` produced. Best-effort: an unreadable file (already handled
 * downstream as a run failure) is skipped here.
 */
async function warnDriftedFiles(ref: SpecRef, manifest: GeneratedManifest, cwd: string): Promise<void> {
  const drifted: string[] = [];
  await Promise.all(
    manifest.files.map(async (f) => {
      const bytes = await readFile(resolve(cwd, f.path)).catch(() => null);
      if (bytes === null) return;
      if (manifestSha256(bytes) !== f.sha256) drifted.push(f.path);
    }),
  );
  if (drifted.length > 0) {
    log.warn(
      `${ref.featureName}/${ref.specName}: generated file(s) changed since 'ccqa generate' ` +
        `(${drifted.join(", ")}) — edits to generated code are overwritten on the next generate; ` +
        `put lasting changes in the spec or the target's resources`,
    );
  }
}

type ManifestReadResult =
  | { ok: true; manifest: GeneratedManifest }
  | { ok: false; missing: boolean; error: string };

/**
 * Read a spec's `generated.json` with the runner's richer error detail (used
 * for its "run `ccqa generate` first" messages). Other consumers that only
 * need the parsed manifest use `loadGeneratedManifest` (llm-engine.ts).
 */
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
  opts: { cwd: string; artifactsDir: string; evidenceDir: string | null; logPath: string },
): Promise<ShellOutcome> {
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    // Fresh CCQA_RUN_ID per spec, same contract as the vitest runner: specs
    // that embed `${CCQA_RUN_ID}` in created-content names must not collide
    // across specs or with a prior run.
    env: {
      ...process.env,
      [ARTIFACTS_DIR_ENV]: opts.artifactsDir,
      CCQA_RUN_ID: buildRunId(),
      ...(opts.evidenceDir ? { [EVIDENCE_DIR_ENV]: opts.evidenceDir } : {}),
    },
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
