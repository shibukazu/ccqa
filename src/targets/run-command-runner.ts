import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { loadAllBlocks, tryReadSpecFile, type SpecRef } from "../store/index.ts";
import { resolveTestPath } from "./test-path.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import type { BlockSpec } from "../types.ts";
import { runPool } from "../runtime/pool.ts";
import { OUTPUT_TAIL_CAP, TailBuffer } from "../run/output-tail.ts";
import { closeMeasurement, specCoverageDir } from "../coverage/session.ts";
import { emptySpecRow } from "../report/spec-row.ts";
import {
  buildStepDescriptions,
  loadEvidenceForSpec,
  specEvidenceDir,
} from "../report/evidence.ts";
import type { ReportArtifact, ReportCoverage, ReportSpecResult } from "../report/schema.ts";
import {
  ARTIFACTS_DIR_ENV,
  collectSpecArtifacts,
  OUTPUT_LOG_FILE,
  specArtifactsDir,
  substituteArtifactsDir,
} from "./run-artifacts.ts";
import type { CdpBrowserHandle, RunnerOptions, TestRunner } from "./types.ts";
import { errMessage } from "../run/errors.ts";
import * as log from "../cli/logger.ts";

/**
 * Substitute `{files}` in a runCommand with the (shell-quoted) cwd-relative
 * test-file paths. Quoting is mandatory: the command runs through `shell: true`
 * and the path comes from a user-authored template, so an unquoted path
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
 * derives the test's path from the target's `testPath` and executes the
 * target's configured `runCommand` with `{files}` expanded to it. Exit 0 =
 * passed, anything else = failed with the output tail in the report row.
 * Targets whose tests are run by an external tool (Playwright, runn, ...) set
 * this as their `runner`.
 */
export const runCommandRunner: TestRunner = {
  async run(specs: readonly SpecRef[], opts: RunnerOptions): Promise<ReportSpecResult[]> {
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
    }, { resources: opts.resources });
  },
};

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

  const testFile = resolveTestPath(opts, opts.targetConfig, ref);
  const generated = await stat(resolve(opts.cwd, testFile)).then(
    () => true,
    () => false,
  );
  if (!generated) {
    const detail = `no generated test at ${testFile} — run 'ccqa generate ${featureName}/${specName}' first`;
    log.error(detail);
    return didNotExecute(detail, "no generated tests");
  }
  const testFiles = [testFile];

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

  // A target that declared no browser is not measured at all: measuring only
  // the server half with no carrier would produce an empty file set, and an
  // empty file set reads as "this spec reached nothing".
  const measurement =
    opts.coverage !== undefined && opts.browserCoverage.browser === "cdp"
      ? { collector: opts.coverage, cdpEndpoint: opts.browserCoverage.cdpEndpoint }
      : null;
  const coverageDir = specCoverageDir(opts.reportDir, featureName, specName);
  if (measurement) {
    await rm(coverageDir, { recursive: true, force: true });
    await mkdir(coverageDir, { recursive: true });
  }

  const childEnv: Record<string, string> = {
    [ARTIFACTS_DIR_ENV]: artifactsDir,
    // Fresh CCQA_RUN_ID per spec, same contract as the vitest runner: specs
    // that embed `${CCQA_RUN_ID}` in created-content names must not collide
    // across specs or with a prior run.
    CCQA_RUN_ID: buildRunId(),
    ...(evidenceDir ? { [EVIDENCE_DIR_ENV]: evidenceDir } : {}),
  };

  let command = substituteArtifactsDir(
    substituteRunCommandFiles(runCommand, testFiles),
    artifactsDir,
  );

  // The browser is stood up and the engine attached before the command is
  // spawned: the ordering is the whole guarantee that no script runs before
  // the profiler is on and no request leaves before the cookie exists.
  let browserHandle: CdpBrowserHandle | undefined;
  let browserEngine: { stop(): Promise<void> } | undefined;
  let attachError: string | undefined;
  if (measurement) {
    await measurement.collector.beginSpec(ref);
    try {
      browserHandle = await measurement.cdpEndpoint({ cwd: opts.cwd, featureName, specName });
      // Registered with the signal teardown as well as disposed in the
      // `finally` below: node bypasses `finally` on an unhandled signal, and
      // a playwright handle owns a browser process and a config file written
      // into the consumer's repo. `dispose` is idempotent for this reason.
      const acquired = browserHandle;
      opts.teardown?.onFinalize(() => acquired.dispose());
      browserEngine = await measurement.collector.armBrowser(ref, browserHandle, coverageDir);
      if (browserHandle.amendCommand) command = browserHandle.amendCommand(command);
      Object.assign(childEnv, browserHandle.env);
    } catch (err) {
      // Requested measurement that cannot happen stops the spec's coverage
      // loudly on the row, never silently narrows it.
      attachError = errMessage(err);
      log.warn(`coverage: could not attach to the target's browser (${attachError})`);
    }
  }

  log.meta("command", command);
  log.blank();

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let outcome: ShellOutcome | undefined;
  let spawnFailure: string | undefined;
  let measured: ReportCoverage | undefined;
  try {
    outcome = await runShellCommand(command, {
      cwd: opts.cwd,
      artifactsDir,
      logPath: join(artifactsDir, OUTPUT_LOG_FILE),
      env: childEnv,
    });
  } catch (err) {
    spawnFailure = err instanceof Error ? err.message : String(err);
  } finally {
    // After the command exits, never during: the application pushes on a timer,
    // and collection waits for those pushes to stop arriving. In a `finally`
    // because `beginSpec` may have opened a turn on an identity, and a turn
    // left open outlives the spec it belonged to — which is why this runs even
    // when the browser never attached. The engine stops first (its final take
    // needs the browser), the browser is torn down last.
    if (browserEngine) await browserEngine.stop().catch(() => undefined);
    if (measurement) measured = await closeMeasurement(measurement.collector, ref, coverageDir);
    if (browserHandle) await browserHandle.dispose().catch(() => undefined);
  }
  const coverageFields = coverageRowFields(opts, measured, attachError);
  if (spawnFailure !== undefined || outcome === undefined) {
    return {
      ...didNotExecute(
        `could not spawn runCommand: ${spawnFailure ?? "unknown error"}`,
        "the runCommand could not be spawned",
      ),
      startedAt,
      ...coverageFields,
    };
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

  if (outcome.exitCode === 0) {
    return {
      ...emptySpecRow({ feature: featureName, spec: specName, title, status: "passed" }),
      target: opts.targetId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      ...artifactFields,
      ...evidenceFields,
      ...coverageFields,
    };
  }
  const detail = [
    `command failed (exit ${outcome.exitCode}): ${command}`,
    outcome.tail.length > 0 ? `--- output (tail) ---\n${outcome.tail}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join("\n");
  return {
    ...failedRow(detail),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    ...artifactFields,
    ...evidenceFields,
    ...coverageFields,
  };
}

/**
 * What the row says about measurement. A half-measured row (the server side
 * only, because the browser never attached) would read as "this spec reached
 * almost nothing", so a failed attach reports its reason instead of numbers.
 */
function coverageRowFields(
  opts: RunnerOptions,
  measured: ReportCoverage | undefined,
  attachError: string | undefined,
): Pick<ReportSpecResult, "coverage" | "coverageUnavailable"> {
  if (attachError !== undefined) {
    return { coverageUnavailable: `could not attach to the target's browser: ${attachError}` };
  }
  if (measured !== undefined) return { coverage: measured };
  if (opts.coverage !== undefined && opts.browserCoverage.browser === "none") {
    return { coverageUnavailable: opts.browserCoverage.reason };
  }
  return {};
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
  opts: { cwd: string; artifactsDir: string; logPath: string; env: Record<string, string> },
): Promise<ShellOutcome> {
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    env: { ...process.env, ...opts.env },
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
