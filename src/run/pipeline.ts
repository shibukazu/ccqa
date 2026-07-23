import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  getTestScript,
  listAllSpecsWithSpecFile,
  loadAllBlocks,
  resolveSpecTargets,
  specKey,
  tryReadSpecFile,
} from "../store/index.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import { AGENT_BROWSER_TARGET, type TestSpec } from "../spec/yaml-schema.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestStreaming } from "../runtime/spawn-vitest.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import {
  analyzeExternalRows,
  beginFailureAnalysis,
  needsAnalysis,
  type FailureAnalysisDeps,
  type FailureAnalysisRun,
} from "./failure-analysis.ts";
import { createDiffProvider, type DiffProvider } from "./diff-provider.ts";
import { LAST_GREEN, resolveAnalysisBase, type GitContext } from "./git-context.ts";
import { createLastGreenResolver, fetchLastGreenLedger } from "./last-green.ts";
import { emitGithubAnnotations } from "../report/github-format.ts";
import { ANALYSIS_PROMPT_VERSION } from "../report/prompt.ts";
import { fetchCustomPrompt, fetchTriageUserPrompt, hashTriageUserPrompt } from "../prompts/custom-prompt.ts";
import { buildStepDescriptions, loadEvidenceForSpec, specEvidenceDir } from "../report/evidence.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import type { LiveReportStep, ReportSpecResult, RunReportData } from "../report/schema.ts";
import { resolveProfileEnv } from "../cli/options.ts";
import { resolveHubContext, HubConnectionError, type HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import { resolveProjectOrThrow, ProjectNameError } from "../cli/resolve-project.ts";
import { resolveSpecsModes } from "../cli/spec-mode.ts";
import { runLiveSpecs, type RunLiveOptions } from "../cli/run-live.ts";
import { loadProjectConfig } from "../config/project-config.ts";
import { groupSpecsByTarget, runExternalSpecs, type TargetDispatch } from "./target-dispatch.ts";
import { createIncrementalReport, type ReportEnvelope, type ReportSink } from "./incremental-report.ts";
import { detectBranch, getGitHead } from "../cli/git-branch.ts";
import { githubRunId, githubRunUrl } from "./github-run.ts";
import { updateAgentPrompt } from "../cli/update-agent-prompt.ts";
import { collectChangedSpecs } from "../cli/changed-specs.ts";
import { C } from "../cli/colors.ts";
import * as log from "../cli/logger.ts";
import { RunUsageError } from "./errors.ts";
import type { RunTeardown } from "../cli/run-teardown.ts";

export { RunUsageError } from "./errors.ts";

// Imported from a dependency-free module so `hub.ts` / `run.ts` can pull these
// constants without importing the whole pipeline (which imports hub-conn and
// would form a startup init-order cycle). Re-exported here for existing
// consumers that still import them from pipeline. See report-constants.ts.
import {
  REPORT_FORMATS,
  DEFAULT_REPORT_DIR,
  EVIDENCE_SUBDIR,
  type ReportFormat,
} from "./report-constants.ts";
export { REPORT_FORMATS, DEFAULT_REPORT_DIR, EVIDENCE_SUBDIR, type ReportFormat };
import { OUTPUT_TAIL_CAP, TailBuffer } from "./output-tail.ts";
export { TailBuffer };

// Passing --config to vitest prevents it from discovering the host's
// vitest.config.ts and inheriting setupFiles/environment/aliases that were
// never meant to apply to ccqa's browser-driving specs.
async function resolveVitestConfig(cwd: string): Promise<string> {
  const userConfig = resolve(cwd, ".ccqa/vitest.config.ts");
  try {
    await access(userConfig);
    return userConfig;
  } catch {
    return bundledVitestConfigPath();
  }
}

type VitestAssertionResult = {
  status: "passed" | "failed" | "skipped" | "pending" | "todo";
  title: string;
  fullName: string;
  duration?: number;
  failureMessages?: string[];
};

type VitestTestResult = {
  name: string;
  status: "passed" | "failed";
  assertionResults: VitestAssertionResult[];
};

type VitestJsonReport = {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  startTime: number;
  success: boolean;
  testResults: VitestTestResult[];
};

export type SpecRunSummary = {
  featureName: string;
  specName: string;
  scriptFile: string;
  report: VitestJsonReport | null;
  exitCode: number;
  /** Tail of the spec's combined vitest output; feeds the drift-report failure analysis. */
  outputTail: string | null;
  /** Directory the spec's step-boundary evidence (PNG + JSON) was written to. */
  evidenceDir: string | null;
};

export interface RunOptions {
  report?: string | boolean;
  cwd?: string;
  profile?: string;
  model?: string;
  language?: string;
  format?: ReportFormat;
  /**
   * Opt-in failure classification: absent/false = off, `true` = baseline from
   * GITHUB_BASE_REF, a string = explicit base ref. See `--failure-analysis
   * [base]` and resolveAnalysisBase.
   */
  failureAnalysis?: boolean | string;
  evidence?: boolean;
  retry?: number;
  out?: string;
  /** Same value shape as `failureAnalysis`: `true` = GITHUB_BASE_REF, string = explicit base. */
  changed?: boolean | string;
  updateAgentPrompt?: boolean;
  concurrency?: number;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
  /** Opt-in for incremental hub push during the run (see run.ts --push-report help). */
  pushReport?: boolean;
  project?: string;
  /** Reap agent-browser sessions / flush the report on SIGINT/SIGTERM. See run-teardown.ts. */
  teardown?: RunTeardown;
}

export interface RunPipelineResult {
  /** 0 when every spec passed, 1 when at least one spec failed. Usage errors throw `RunUsageError` instead. */
  exitCode: 0 | 1;
  /** The written report; null only when there were no specs to run. */
  report: RunReportData | null;
  /** Where the report was written; null only when there were no specs to run. */
  reportDir: string | null;
}

/**
 * Resolve the report directory. A report (report.json + evidence) is always
 * written now, so this is never undefined: `--report <dir>` only picks *where*
 * it lands, defaulting to `DEFAULT_REPORT_DIR`. `--report` with no value (a
 * bare boolean flag) also means "default location".
 */
function resolveReportDir(report: string | boolean | undefined, cwd: string): string {
  const raw = typeof report === "string" ? report : DEFAULT_REPORT_DIR;
  return resolve(cwd, raw);
}

/** De-dupe by `featureName/specName`, keeping first-seen order. */
function dedupeSpecs(
  specs: Array<{ featureName: string; specName: string }>,
): Array<{ featureName: string; specName: string }> {
  const seen = new Set<string>();
  const out: Array<{ featureName: string; specName: string }> = [];
  for (const s of specs) {
    const key = `${s.featureName}/${s.specName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Run specs and (optionally) write a unified report. This is the library
 * core behind `ccqa run` — it never calls `process.exit`. Usage errors
 * (bad flag combinations, a broken profile, a failed `git diff`) throw
 * `RunUsageError`; the caller decides what to do with it (the CLI action
 * maps it to `process.exit(2)`).
 */
export async function executeRun(
  targets: string[],
  opts: RunOptions,
): Promise<RunPipelineResult> {
  if (opts.changed && targets.length > 0) {
    throw new RunUsageError("--changed and an explicit spec target cannot be combined");
  }

  const cwd = opts.cwd ?? process.cwd();

  // Resolve git coordinates before anything else runs: `head` is recorded in
  // the report unconditionally, and an unresolvable --failure-analysis
  // baseline must fail here — a fast usage error — not after minutes of spec
  // execution. `base` stays null when analysis wasn't requested, which is
  // what downstream reads as "classification off". The last-green mode needs
  // the hub connection, so its ledger fetch happens below once hubCtx exists;
  // the fixed-ref modes fail fast right here.
  const wantsLastGreen = opts.failureAnalysis === LAST_GREEN;
  const [head, fixedBase] = await Promise.all([
    getGitHead(cwd),
    opts.failureAnalysis && !wantsLastGreen
      ? resolveAnalysisBase(opts.failureAnalysis, "--failure-analysis", cwd)
      : null,
  ]);
  const git: GitContext = {
    head,
    base: wantsLastGreen ? { ref: LAST_GREEN, sha: null, source: "last-green" } : fixedBase,
  };
  let diffProvider: DiffProvider | null = null;
  if (fixedBase) {
    diffProvider = createDiffProvider({ resolveBase: async () => ({ ok: true, base: fixedBase }), cwd });
    log.meta("analysis-base", `${fixedBase.ref} (${fixedBase.sha.slice(0, 12)}, ${fixedBase.source})`);
  }

  // Merge the profile (fetched from the hub) or the default .env (when no
  // --profile) into process.env before any spec work — every `${VAR}` path
  // (vitest replay, live agent-browser) bottoms out at process.env, so this
  // single injection covers both modes. A broken profile is a usage error
  // (bad flag / hub misconfiguration), not a run failure, so it maps to
  // RunUsageError like the other early-exit checks. Project resolution is
  // only needed to scope the hub lookup, so it's skipped entirely when no
  // --profile is given. The resolved name is kept (not recomputed) below to
  // also scope the best-effort custom-prompt hub lookup.
  let projectForProfile: string | undefined;
  try {
    if (opts.profile !== undefined) {
      projectForProfile = resolveProjectOrThrow(opts.project, cwd);
      await resolveProfileEnv({
        profile: opts.profile,
        project: projectForProfile,
        cwd,
        hubUrl: opts.hubUrl,
        hubToken: opts.hubToken,
        hubHeader: opts.hubHeader,
      });
    } else {
      await resolveProfileEnv({ profile: undefined, project: "", cwd });
    }
  } catch (err) {
    if (err instanceof RunUsageError) throw err;
    if (err instanceof ProjectNameError) throw new RunUsageError(err.message);
    if (err instanceof HubConnectionError || err instanceof HubApiError) {
      throw new RunUsageError(err.message);
    }
    throw new RunUsageError(
      `failed to load profile "${opts.profile}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Resolve the hub context for the failure-analysis prompts (best-effort: an
  // unresolvable project or missing hub connection just means no custom
  // prompt, never a run-stopping error — unlike the profile resolution
  // above, which does throw RunUsageError). resolveHubContext re-resolves
  // the project internally rather than reusing projectForProfile — this
  // mirrors the pre-refactor code, which already resolved the project twice
  // (once for the profile, once here).
  let hubCtx: HubContext | null = null;
  try {
    hubCtx = resolveHubContext({
      hubUrl: opts.hubUrl,
      hubToken: opts.hubToken,
      hubHeader: opts.hubHeader,
      project: opts.project,
      cwd,
    });
  } catch {
    hubCtx = null;
  }

  // last-green baselines live on the hub, so the ledger fetch has to wait for
  // hubCtx — but it still happens before any spec executes, keeping the
  // fail-fast contract of the fixed-ref modes above. Requiring a hub here is
  // deliberate: the flag opted into hub-backed baselines, so a missing
  // connection is a usage error, not a degrade-to-no-analysis.
  if (wantsLastGreen && hubCtx == null) {
    throw new RunUsageError(
      `--failure-analysis=${LAST_GREEN} requires a hub connection (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN)`,
    );
  }
  const ledgerHub = wantsLastGreen ? hubCtx : null;

  // Two failure-analysis prompt layers, both best-effort (null without a hub):
  // the human-maintained `triage.user` guidance and the learned custom prompt.
  // The last-green ledger (when requested) joins the same batch — all three
  // are independent hub round trips.
  const [customPrompt, triageUserPrompt, ledgerEntries] = await Promise.all([
    fetchCustomPrompt(hubCtx),
    fetchTriageUserPrompt(hubCtx),
    ledgerHub ? fetchLastGreenLedger(ledgerHub, opts.profile, cwd) : null,
  ]);
  if (ledgerEntries) {
    diffProvider = createDiffProvider({
      resolveBase: createLastGreenResolver(ledgerEntries, cwd),
      cwd,
    });
  }
  const triageUserPromptHash = triageUserPrompt ? hashTriageUserPrompt(triageUserPrompt) : null;

  // Resolve report dir against `cwd` (not process.cwd()) so JSON and evidence
  // PNGs share a directory even when --cwd points at a subpackage. A report is
  // always written now; --report only picks where. Resolved up front so the
  // analysis deps below can carry it (they locate a spec's run artifacts).
  const reportDir = resolveReportDir(opts.report, cwd);

  // Everything the failure analysis needs, resolved once and shared by every
  // execution path that classifies (deterministic + external targets; the live
  // path builds its own from RunLiveOptions). The Claude-credential probe can
  // hit the macOS Keychain, so it happens here rather than per phase — and only
  // when a baseline was requested, since that is what turns analysis on.
  const analysisDeps: FailureAnalysisDeps = {
    diffProvider,
    auth: diffProvider ? driftAuthAvailable() : { ok: false, reason: "skipped by flags" },
    cwd,
    reportDir,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    customPrompt,
    triageUserPrompt,
  };

  // No targets means "all specs"; resolveSpecTargets(undefined) enumerates them.
  // Multiple targets may overlap (e.g. a feature plus one of its specs), so dedupe.
  const enumerateAll = () => listAllSpecsWithSpecFile(cwd);
  const resolved = await Promise.all(
    (targets.length ? targets : [undefined]).map((t) => resolveSpecTargets(t, enumerateAll, cwd)),
  );
  let specs = dedupeSpecs(resolved.flat());

  if (opts.changed) {
    const before = specs.length;
    specs = await collectChangedSpecs(specs, { cwd, base: opts.changed });
    log.meta(
      "changed-scoped",
      `${specs.length} of ${before} spec${before === 1 ? "" : "s"}`,
    );
  }

  if (specs.length === 0) {
    log.warn("no specs to run");
    return { exitCode: 0, report: null, reportDir: null };
  }

  // Split specs by generation target: agent-browser specs keep the det/live
  // paths below; external-target specs run through their plugin runner; specs
  // that can't run at all become report rows (skipped / failed) instead of
  // silently dropping out of the run.
  let dispatch: TargetDispatch;
  try {
    dispatch = await groupSpecsByTarget(specs, await loadProjectConfig(cwd), cwd);
  } catch (err) {
    // A present-but-broken .ccqa/config.yaml is a usage error, like a bad flag.
    throw new RunUsageError(errMessage(err));
  }

  // Agent-browser det specs run first under vitest, then external targets,
  // then live ones via Claude; results merge into a single report.json.
  const withMode = await resolveSpecsModes(dispatch.agentBrowser, cwd);
  const detSpecs = withMode.filter((s) => s.mode === "deterministic");
  const liveSpecs = withMode.filter((s) => s.mode === "live");
  log.meta(
    "modes",
    `${detSpecs.length} deterministic / ${liveSpecs.length} live`,
  );
  if (dispatch.external.length > 0) {
    log.meta(
      "external",
      dispatch.external.map((g) => `${g.targetId} ${g.specs.length}`).join(" / "),
    );
  }

  // Warn when a mode-scoped flag can't apply, rather than silently ignoring
  // it. These flags only affect agent-browser specs of the given mode —
  // external-target specs run via their own runCommand and never honor them.
  if (liveSpecs.length === 0) {
    const why = "it only applies to agent-browser 'mode: live' specs, and this run has none";
    if (typeof opts.retry === "number" && opts.retry > 0) log.warn(`--retry is ignored: ${why}`);
    if (opts.out) log.warn(`--out is ignored: ${why}`);
    if (opts.updateAgentPrompt) log.warn(`--update-agent-prompt is ignored: ${why}`);
  } else if (opts.out && liveSpecs.length > 1) {
    // A single --out dir can't hold multiple specs' artifacts without them
    // overwriting each other (worse under --concurrency), so it only applies
    // to single-spec runs, matching the flag's help text.
    log.warn("--out is ignored when running multiple live specs");
  }
  if (detSpecs.length === 0 && opts.evidence === false) {
    log.warn(
      "--no-evidence is ignored: it only applies to agent-browser 'mode: deterministic' specs, and this run has none",
    );
  }
  log.blank();

  const det = await runDeterministicSpecs(detSpecs, opts, cwd, reportDir);

  // Incremental hub push: when --push-report is set and a hub is configured,
  // open a "running" run up front so each finished spec can be PATCHed to the
  // hub as it lands (real-time reflection of a long run). The report dir always
  // exists, so the only thing that can still block the push is a missing hub
  // connection. Best-effort throughout — a hub failure never fails the local
  // run (test execution is the point). The open is not retried: a dropped
  // response could leave a second orphan running run, so on failure we degrade
  // to local-report-only.
  if (opts.pushReport && hubCtx == null) {
    log.warn("--push-report requires --hub-url/--hub-token (or CCQA_HUB_URL/CCQA_HUB_TOKEN); skipping push");
  }
  let hubRunId: string | null = null;
  let hubSink: ReportSink | undefined;
  if (hubCtx != null && opts.pushReport) {
    try {
      const branch = await detectBranch(cwd);
      const ciRunId = githubRunId();
      const runUrl = githubRunUrl();
      const opened = await hubCtx.hub.openRun({
        project: hubCtx.project,
        ...(branch ? { branch } : {}),
        ...(opts.profile ? { profile: opts.profile } : {}),
        ...(git.head ? { gitHead: git.head } : {}),
        ...(ciRunId ? { ciRunId } : {}),
        ...(runUrl ? { runUrl } : {}),
        kind: "run",
      });
      hubRunId = opened.id;
      log.info(`hub: incremental run opened (${opened.id})`);
      const runId = opened.id;
      hubSink = {
        onUpsert: async (row) => {
          try {
            const evidence = await readRowFilesBase64(row, reportDir);
            await hubCtx.hub.patchRun(runId, { rows: [row], evidence });
          } catch (err) {
            log.warn(`hub: incremental push failed for ${row.feature}/${row.spec}: ${errMessage(err)}`);
          }
        },
      };
    } catch (err) {
      log.warn(`hub: could not open incremental run (${errMessage(err)}); continuing with local report only`);
    }
  }

  // Incremental report: external-target and live specs upsert their rows and
  // flush report.json as they finish, so an interrupt leaves a valid partial
  // report instead of nothing. The git coordinates were resolved up front, so
  // even an interrupted partial report carries the real head/base — the final
  // writeUnifiedReport rewrites the whole file with the same envelope.
  //
  // Scope note: only the external and live phases upsert incrementally.
  // Deterministic rows are built later (analyzeDeterministicSummaries) and only
  // reach the report / hub via the final write + seal patch, so an interrupt
  // before that point omits already-finished det specs from the partial report.
  // Det specs are fast and run first, so this window is small; full det
  // incrementalism is deferred.
  const incrementalReport = createIncrementalReport(
    reportDir,
    buildReportEnvelope({
      git,
      customPromptVersion: customPrompt?.customPromptVersion ?? null,
      triageUserPromptHash,
      opts,
    }),
    hubSink,
  );
  // On SIGINT/SIGTERM, flush whatever rows finished so an interrupt leaves a
  // valid partial report. Skipped once the run completes normally: the final
  // writeUnifiedReport below is authoritative (it holds the deterministic
  // rows the incremental writer never sees), so re-flushing the incremental
  // writer afterwards would clobber it — the teardown finalizer also runs on
  // the normal exit path (run.ts).
  let completedNormally = false;
  opts.teardown?.onFinalize(async () => {
    // On the normal exit path the final writeUnifiedReport (below) is
    // authoritative and already closed the hub run, so skip both.
    if (completedNormally) return;
    await incrementalReport.flush();
    // Flip the hub's still-"running" run to a terminal state so an interrupt
    // doesn't leave it dangling (the startup GC would otherwise have to reap
    // it). The rows already patched stay; we just finalize. finalStatus is
    // "failed" — the run was interrupted, not a clean pass. Best-effort.
    if (hubRunId && hubCtx) {
      try {
        await hubCtx.hub.patchRun(hubRunId, { rows: incrementalReport.rows(), done: true, finalStatus: "failed" });
      } catch (err) {
        log.warn(`hub: could not finalize interrupted run ${hubRunId}: ${errMessage(err)}`);
      }
    }
  });

  // External-target specs run between the det and live phases. Rows (including
  // the skipped / target-resolution-failure stubs) are upserted into the
  // incremental report as each spec finishes, so an interrupt and
  // --push-report treat them like live rows. Their failure analysis happens
  // in the tail phase below, with the deterministic one.
  const externalRows = await runExternalSpecs(dispatch, {
    cwd,
    reportDir,
    concurrency: opts.concurrency ?? 1,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    report: incrementalReport,
  });

  const liveOpts: RunLiveOptions = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.out && liveSpecs.length === 1 ? { out: opts.out } : {}),
    cwd,
    reportDir,
    ...(typeof opts.retry === "number" ? { retry: opts.retry } : {}),
    concurrency: opts.concurrency ?? 1,
    ...(opts.profile ? { profile: opts.profile } : {}),
    diffProvider,
    hubContext: hubCtx,
    customPrompt,
    triageUserPrompt,
    ...(opts.teardown ? { teardown: opts.teardown } : {}),
    report: incrementalReport,
  };
  const live = await runLiveSpecs(liveSpecs, liveOpts);

  let overallExitCode: 0 | 1 = det.exitCode !== 0 ? 1 : 0;
  if (live.failedCount > 0) overallExitCode = 1;
  // Failed external rows (command exit != 0, missing manifest, unresolved
  // target) fail the run; skipped rows don't.
  if (externalRows.some((r) => r.status === "failed")) overallExitCode = 1;

  const customPromptVersion = customPrompt?.customPromptVersion ?? null;
  let report: RunReportData;
  {
    // One analysis phase for the whole run, opened once every spec has
    // executed: the audit batches across execution paths and the classifier's
    // banner is printed once, in one place. The live path classifies inline
    // (its evidence is the transcript it just produced), so its rows arrive
    // analyzed and only det + external rows pass through here.
    const detFailed = det.summaries.filter(failedSpec);
    const analysisRun = await beginFailureAnalysis(
      [
        ...detFailed.map((s) => ({ featureName: s.featureName, specName: s.specName })),
        ...externalRows
          .filter(needsAnalysis)
          .map((r) => ({ featureName: r.feature, specName: r.spec })),
      ],
      analysisDeps,
    );
    const detResults = await analyzeDeterministicSummaries(
      det.summaries,
      cwd,
      reportDir,
      analysisRun,
    );
    const analyzedExternalRows = await analyzeExternalRows(externalRows, analysisRun);
    report = await writeUnifiedReport({
      reportDir,
      results: [...detResults, ...analyzedExternalRows, ...live.reportResults],
      git,
      customPromptVersion,
      triageUserPromptHash,
      opts,
    });
    // The authoritative report is on disk; a later teardown flush (normal exit
    // or a signal arriving now) must not overwrite it with the provisional one.
    completedNormally = true;

    // Reconcile the hub run: re-send every final row (upsert is idempotent, so
    // this heals any mid-run patch that failed), stamp the real git metadata
    // the provisional per-spec patches lacked, and flip running → terminal.
    // Best-effort: a hub failure here still leaves a complete local report.
    if (hubRunId) {
      const finalStatus = overallExitCode === 0 ? "passed" : "failed";
      const reportMeta = buildReportEnvelope({
        git,
        customPromptVersion,
        triageUserPromptHash,
        opts,
      });
      // Deterministic rows are the only ones that never passed through the
      // mid-run sink (external/live rows already pushed their files with their
      // own patches), so their evidence PNGs must ride along on this seal PATCH
      // or the hub UI's det step frames 404. Collect files only for rows that
      // weren't streamed, under one shared byte budget.
      const streamedKeys = new Set(incrementalReport.rows().map((r) => `${r.feature}/${r.spec}`));
      const sealRows = report.results.filter((r) => !streamedKeys.has(`${r.feature}/${r.spec}`));
      const evidence = await readRowsFilesBase64(sealRows, reportDir);
      try {
        await hubCtx!.hub.patchRun(hubRunId, {
          rows: report.results,
          evidence,
          done: true,
          finalStatus,
          reportMeta,
        });
        log.info(`hub: incremental run finalized (${hubRunId}, ${finalStatus})`);
      } catch (err) {
        log.warn(`hub: could not finalize incremental run ${hubRunId}: ${errMessage(err)}`);
      }
    }
  }

  // "ignored without any 'mode: live' spec" already warned upfront alongside
  // the other live-only flags.
  if (opts.updateAgentPrompt && liveSpecs.length > 0) {
    log.blank();
    await updateAgentPrompt({
      kind: "live",
      runSummary: buildLiveRunSummary(live.reportResults),
      hubContext: hubCtx,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });
  }

  return { exitCode: overallExitCode, report, reportDir };
}

/**
 * Compact, prompt-friendly summary of one ccqa run for the live agent-prompt
 * update step. One section per spec: header line + per-step verdicts (see
 * `liveStepSummaryLine`). Kept to a few KB even with many specs/steps so the
 * prompt cache can absorb the bulk.
 */
export function buildLiveRunSummary(results: readonly ReportSpecResult[]): string {
  const sections: string[] = [];
  for (const r of results) {
    if (!r.liveRun) continue;
    const head = `## ${r.feature}/${r.spec} — ${r.status}`;
    const steps = r.liveRun.steps.map(liveStepSummaryLine).join("\n");
    sections.push(`${head}\n${steps}`);
  }
  return sections.length === 0 ? "(no live runs executed)" : sections.join("\n\n");
}

/**
 * One step's line for the learning summary. Leads with the step's
 * `instruction` (its intent) so the learner can abstract "this was a login" /
 * "this was a static-banner check" and turn the shortcut into a rule keyed on
 * the *kind* of screen/operation rather than this spec's step id. The step id
 * is demoted to a trailing tag — it has no cross-spec meaning, so it must not
 * be the thing the learner anchors on. Churned steps additionally carry their
 * `expected` and the commands that worked (with per-run snapshot refs masked).
 */
function liveStepSummaryLine(s: LiveReportStep): string {
  const turns = s.cost.numTurns;
  const cost = s.cost.totalCostUsd;
  const metrics = [
    turns !== null ? `${turns} turns` : null,
    `${(s.durationMs / 1000).toFixed(1)}s`,
    cost !== null ? `$${cost.toFixed(3)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(", ");
  const head = `- [${s.status}] ${oneLineSummary(s.instruction)} (${metrics}, ${s.stepId}): ${oneLineSummary(s.reasoning)}`;
  // Only surface commands for steps that took real exploration — a step that
  // passed in 1-2 turns has no shortcut worth learning.
  const worthShortcut = (turns ?? 0) >= LIVE_SHORTCUT_TURN_THRESHOLD;
  const commands = s.commands ?? [];
  if (!worthShortcut || commands.length === 0) return head;
  const cmdList = commands.map((c) => oneLineSummary(maskRunLocalTokens(c))).join(" ; ");
  return `${head}\n  expected: ${oneLineSummary(s.expected)}\n  commands (snapshot refs masked — re-derive from each element's role/label/text): ${cmdList}`;
}

/**
 * Strip run-local tokens from a command string before it enters the learning
 * input. Two kinds are noise a cross-spec rule must never carry forward:
 *   - snapshot refs (`@e4`, `@e12`) — renumbered every run, so a copied ref
 *     points nowhere or misclicks next run; masked to `@ref` to force the
 *     learner to describe the element by its stable identity instead.
 *   - the per-run `--session <id>` flag — a fresh timestamped id each run, pure
 *     noise that only tempts the learner to paste a dead session name.
 */
function maskRunLocalTokens(command: string): string {
  return command.replace(/@e\d+/g, "@ref").replace(/\s--session\s+\S+/g, "");
}

/**
 * A step at or above this many turns did enough exploring that its command
 * trail is worth learning a shortcut from. Below it, the step is already fast.
 */
const LIVE_SHORTCUT_TURN_THRESHOLD = 3;

function oneLineSummary(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? flat.slice(0, 240) + "…" : flat || "(no reason given)";
}

type RunDeterministicResult = {
  summaries: SpecRunSummary[];
  exitCode: number;
};

/**
 * Run pre-filtered deterministic specs under vitest. Empty input is a no-op.
 * Captures step-boundary evidence under `<reportDir>/evidence/<feature>/<spec>/`
 * when enabled.
 */
async function runDeterministicSpecs(
  specs: readonly { featureName: string; specName: string }[],
  opts: RunOptions,
  cwd: string,
  reportDirAbs: string,
): Promise<RunDeterministicResult> {
  if (specs.length === 0) return { summaries: [], exitCode: 0 };

  const tmpDir = await mkdtemp(join(tmpdir(), "ccqa-run-"));
  const vitestConfig = await resolveVitestConfig(cwd);
  // A report is always written, so keep the vitest output tail unless failure
  // analysis (its only consumer, via failureLogExcerpt) is turned off.
  const captureOutput = opts.failureAnalysis !== false;
  // Evidence lives under the report dir for the standalone CI artifact; the
  // per-spec dir is composed via specEvidenceDir at capture time.
  const captureEvidence = opts.evidence !== false;
  // Parallel vitest streams interleave illegibly, so above 1 worker each spec
  // buffers its narration + vitest output (via log.withBuffer) and flushes one
  // labelled block on completion. At 1 worker output streams live, as before.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const ctx: DeterministicSpecContext = {
    cwd,
    tmpDir,
    vitestConfig,
    captureOutput,
    reportDir: reportDirAbs,
    captureEvidence,
  };

  try {
    const settled = await runPool(specs, concurrency, (spec, i) =>
      log.withBuffer(`${spec.featureName}/${spec.specName}`, concurrency > 1, () =>
        runOneDeterministicSpec(spec, i, ctx),
      ),
    );
    // runPool preserves input order, so summaries stay stable for the report.
    const summaries = settled.filter((s): s is SpecRunSummary => s !== null);
    printSummary(summaries);
    const exitCode = summaries.reduce((acc, s) => (s.exitCode !== 0 ? s.exitCode : acc), 0);
    return { summaries, exitCode };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

interface DeterministicSpecContext {
  cwd: string;
  tmpDir: string;
  vitestConfig: string;
  captureOutput: boolean;
  reportDir: string;
  captureEvidence: boolean;
}

/**
 * Run one spec under vitest. Returns null when the spec has no recorded
 * test.spec.ts (skipped). All output goes through the logger, so under a
 * `log.withBuffer` scope it's captured and flushed as one labelled block.
 */
async function runOneDeterministicSpec(
  spec: { featureName: string; specName: string },
  index: number,
  ctx: DeterministicSpecContext,
): Promise<SpecRunSummary | null> {
  const { featureName, specName } = spec;
  const scriptFile = await getTestScript(featureName, specName, ctx.cwd);
  if (!scriptFile) {
    log.warn(`${featureName}/${specName}: no test.spec.ts found`);
    log.hint("run 'ccqa record <feature>/<spec>' to record it, or set 'mode: live' in spec.yaml");
    return null;
  }

  log.run(`${featureName}/${specName}`);
  log.meta("test", scriptFile);
  // Unique-per-spec run id, mirroring the live path (run-live.ts): generated
  // once, logged, and handed to the spec as CCQA_RUN_ID. A spec that embeds
  // `${CCQA_RUN_ID}` (e.g. in created-content names) needs this set; otherwise
  // the ref resolves to "" and the run collides with a prior one.
  const runId = buildRunId();
  log.meta("runId", runId);
  log.blank();

  const reportFile = join(ctx.tmpDir, `report-${index}.json`);
  const evidenceDir = ctx.captureEvidence ? specEvidenceDir(ctx.reportDir, featureName, specName) : null;
  if (evidenceDir) {
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(evidenceDir, { recursive: true });
  }
  const specEnv: NodeJS.ProcessEnv = { ...process.env, CCQA_RUN_ID: runId };
  if (evidenceDir) specEnv[EVIDENCE_DIR_ENV] = evidenceDir;
  const proc = spawnVitestStreaming(
    [
      "run",
      "--config",
      ctx.vitestConfig,
      scriptFile,
      "--reporter=json",
      `--outputFile.json=${reportFile}`,
    ],
    {
      cwd: ctx.cwd,
      env: specEnv,
    },
  );

  // vitest's stdout/stderr aren't logger lines; route them through emitRaw so
  // they land in the same buffer as the narration above under a buffered scope.
  const sink = { write: log.emitRaw };
  const tail = ctx.captureOutput ? new TailBuffer(OUTPUT_TAIL_CAP) : null;
  await Promise.all([
    streamFiltered(proc.stdout, sink, tail),
    streamFiltered(proc.stderr, sink, tail),
  ]);
  const specExitCode = await proc.exited;
  log.blank();

  const report = await readReport(reportFile);
  return {
    featureName,
    specName,
    scriptFile,
    report,
    exitCode: specExitCode,
    outputTail: tail ? tail.toString() : null,
    evidenceDir,
  };
}

export function failedSpec(s: SpecRunSummary): boolean {
  if (s.exitCode !== 0) return true;
  return (s.report?.numFailedTests ?? 0) > 0;
}

/**
 * Build ReportSpecResult[] for a set of vitest summaries, running the drift
 * audit + failure analysis for the failed ones (see failure-analysis.ts, which
 * external-target specs share). Degrades — never throws — when Claude auth or
 * the git diff aren't available. Caller writes report.json.
 */
async function analyzeDeterministicSummaries(
  summaries: readonly SpecRunSummary[],
  cwd: string,
  reportDir: string,
  { pass, driftByKey }: FailureAnalysisRun,
): Promise<ReportSpecResult[]> {
  // Load blocks once (shared across all specs) so evidence captions can show
  // the step's `expected` text from spec.yaml, including block-inlined steps.
  const allBlocks = await loadAllBlocks(cwd);

  const results: ReportSpecResult[] = [];
  for (const s of summaries) {
    const assertions = collectAssertions(s);
    // Read spec.yaml once and reuse for both evidence captions and the
    // failure-analysis prompt.
    const specYaml = await tryReadSpecFile(s.featureName, s.specName, cwd);
    const parsedSpec = tryParseTestSpec(specYaml);
    const stepDescriptions = buildStepDescriptions(parsedSpec, allBlocks);
    const evidence = await loadEvidenceForSpec(s.evidenceDir, reportDir, stepDescriptions);
    const base = {
      feature: s.featureName,
      spec: s.specName,
      title: parsedSpec?.title ?? null,
      target: AGENT_BROWSER_TARGET,
      testCounts: s.report
        ? {
            total: s.report.numTotalTests,
            passed: s.report.numPassedTests,
            failed: s.report.numFailedTests,
          }
        : null,
      durationMs: assertions
        ? assertions.reduce((sum, a) => sum + (a.durationMs ?? 0), 0)
        : null,
      assertions,
      evidence,
    };

    if (!failedSpec(s)) {
      results.push({
        ...base,
        status: "passed",
        analysis: null,
        analysisSkipped: null,
        driftIssues: null,
        failureLogExcerpt: null,
        diffExcerpt: null,
        specYaml: null,
        liveRun: null,
      });
      continue;
    }

    const driftIssues = driftByKey.get(specKey({ featureName: s.featureName, specName: s.specName })) ?? null;
    const failureLog = buildFailureLog(s);
    const fields = await pass.analyze({
      featureName: s.featureName,
      specName: s.specName,
      readScript: () => readScriptSafe(s.scriptFile),
      failureLog,
      specYaml,
      target: AGENT_BROWSER_TARGET,
      driftIssues,
    });

    // Spell out the failed-row keys in the historical order (analysis,
    // analysisSkipped, analysisBase?, driftIssues, failureLogExcerpt,
    // diffExcerpt, specYaml, liveRun) rather than spreading `fields` — a
    // spread would reorder `diffExcerpt` and change report.json byte-for-byte,
    // which the e2e goldens and cross-version diffs care about.
    results.push({
      ...base,
      status: "failed",
      analysis: fields.analysis,
      analysisSkipped: fields.analysisSkipped,
      ...(fields.analysisBase ? { analysisBase: fields.analysisBase } : {}),
      ...(fields.customPromptVersion ? { customPromptVersion: fields.customPromptVersion } : {}),
      driftIssues,
      failureLogExcerpt: failureLog.length > 0 ? failureLog : null,
      diffExcerpt: fields.diffExcerpt,
      specYaml,
      liveRun: null,
    });
  }

  return results;
}

/**
 * Build the report envelope — every `RunReportData` field except `results`.
 * Extracted so the incremental writer (which flushes report.json after each
 * spec) and the final batch write share one source of truth for these fields.
 * Key order matches the historical `writeUnifiedReport` object literal so the
 * final report.json stays byte-identical (existing e2e goldens compare it).
 */
function buildReportEnvelope(args: {
  git: GitContext;
  customPromptVersion: string | null;
  triageUserPromptHash: string | null;
  opts: RunOptions;
}): ReportEnvelope {
  const { git, customPromptVersion, triageUserPromptHash, opts } = args;
  const runUrl = githubRunUrl();
  return {
    schemaVersion: 1,
    kind: "run",
    createdAt: new Date().toISOString(),
    runId: githubRunId(),
    // Omitted (not null) outside CI so report.json stays byte-identical to
    // before this field — same convention as triageUserPromptHash below.
    ...(runUrl !== null ? { runUrl } : {}),
    git: {
      head: git.head,
      base: git.base?.ref ?? null,
      // Omitted (not null) when analysis is off, so the envelope keeps its
      // historical shape — same contract as triageUserPromptHash below. In
      // last-green mode `sha` is null (per-spec, see analysisBase) but the
      // keys are present: analysis WAS requested.
      ...(git.base ? { baseSha: git.base.sha, baseSource: git.base.source } : {}),
    },
    model: opts.model ?? null,
    language: opts.language ?? null,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    customPromptVersion,
    // Omitted (not null) when inactive, so the envelope keeps its historical
    // shape — see the schema comment on triageUserPromptHash.
    ...(triageUserPromptHash !== null ? { triageUserPromptHash } : {}),
  };
}

/** Write the unified JSON (+ optional GitHub-annotation) report for one run. Returns the report data. */
async function writeUnifiedReport(args: {
  reportDir: string;
  results: ReportSpecResult[];
  git: GitContext;
  customPromptVersion: string | null;
  triageUserPromptHash: string | null;
  opts: RunOptions;
}): Promise<RunReportData> {
  const { reportDir, results, git, customPromptVersion, triageUserPromptHash, opts } = args;
  const data: RunReportData = {
    ...buildReportEnvelope({ git, customPromptVersion, triageUserPromptHash, opts }),
    results,
  };

  await mkdir(reportDir, { recursive: true });

  // report.json is the report: the machine-readable form `ccqa hub push`
  // uploads and any CI tooling consumes. There is no standalone HTML report —
  // the hub UI renders results from report.json + the evidence PNGs. `--format
  // github` additionally streams GitHub Actions annotations to stdout.
  const jsonPath = join(reportDir, "report.json");
  await writeFile(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  log.info(`run report (json) written to ${jsonPath}`);
  if (opts.format === "github") {
    for (const line of emitGithubAnnotations(data)) log.emitRaw(line + "\n");
  }

  return data;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Raw-byte budget for the files inlined in one incremental `PATCH`. Base64
 * inflates by ~4/3 and the rows ride in the same body, so this keeps the
 * request under the hub's default push cap (`serve --max-push-mb`, 32 MB).
 * Artifacts over the budget are omitted from the *hub* push only (named in a
 * warning); they stay in the local report dir and in `ccqa hub push` bundles.
 */
const PATCH_FILES_RAW_BUDGET = 20 * 1024 * 1024;

/** Accumulator threaded across rows so a multi-row push shares one byte budget. */
interface RowFilesAcc {
  out: Record<string, string>;
  totalBytes: number;
  omitted: string[];
}

/**
 * Add one row's file assets to `acc` as `{ reportDir-relative posix path →
 * base64 }`. Every kind of screenshot a row can carry has to be collected here,
 * or `--push-report` — the way CI publishes — silently ships a report whose
 * images 404 on the hub: a live row's per-step PNGs
 * (`liveRun.steps[].beforePng/afterPng`), a script-driven row's step evidence
 * (`evidence[].pngPath` / `beforePngPath`, written by agent-browser replays and
 * by external targets' `ccqa/step-evidence` calls alike), and an external row's
 * `artifacts`. A file that can't be read (capture miss) is skipped, not fatal.
 *
 * Order matters under the byte budget: step evidence is the report's primary
 * visual, so it is offered before the generic artifacts — a multi-megabyte
 * Playwright trace must not crowd out the screenshots.
 */
async function accumulateRowFiles(
  row: ReportSpecResult,
  reportDir: string,
  acc: RowFilesAcc,
): Promise<void> {
  const add = async (relPath: string, sizeGuard: boolean): Promise<void> => {
    if (acc.out[relPath] !== undefined) return;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(reportDir, relPath));
    } catch {
      return; // best-effort: a missing file just isn't pushed with this patch.
    }
    if (sizeGuard && acc.totalBytes + bytes.length > PATCH_FILES_RAW_BUDGET) {
      acc.omitted.push(relPath);
      return;
    }
    acc.out[relPath] = bytes.toString("base64");
    acc.totalBytes += bytes.length;
  };
  for (const step of row.liveRun?.steps ?? []) {
    for (const relPath of [step.beforePng, step.afterPng]) {
      if (relPath) await add(relPath, false);
    }
  }
  for (const e of row.evidence ?? []) {
    for (const relPath of [e.beforePngPath, e.pngPath]) {
      if (relPath) await add(relPath, true);
    }
  }
  for (const artifact of row.artifacts ?? []) await add(artifact.path, true);
}

/** One row's file assets for a mid-run per-row `PATCH` (the incremental sink). */
export async function readRowFilesBase64(
  row: ReportSpecResult,
  reportDir: string,
): Promise<Record<string, string>> {
  const acc: RowFilesAcc = { out: {}, totalBytes: 0, omitted: [] };
  await accumulateRowFiles(row, reportDir, acc);
  if (acc.omitted.length > 0) {
    log.warn(
      `hub: ${acc.omitted.length} file(s) of ${row.feature}/${row.spec} omitted from the ` +
        `incremental push (over the push size budget); they remain in the local report dir: ` +
        acc.omitted.join(", "),
    );
  }
  return acc.out;
}

/**
 * File assets for several rows under one shared byte budget, for the finalizing
 * seal `PATCH`. Deterministic rows never go through the mid-run sink (they are
 * built only at the end), so this is the ONLY chance to upload their evidence
 * PNGs — without it the hub UI's det step frames 404.
 */
export async function readRowsFilesBase64(
  rows: readonly ReportSpecResult[],
  reportDir: string,
): Promise<Record<string, string>> {
  const acc: RowFilesAcc = { out: {}, totalBytes: 0, omitted: [] };
  for (const row of rows) await accumulateRowFiles(row, reportDir, acc);
  if (acc.omitted.length > 0) {
    log.warn(
      `hub: ${acc.omitted.length} file(s) omitted from the finalizing push (over the push size ` +
        `budget); they remain in the local report dir: ${acc.omitted.join(", ")}`,
    );
  }
  return acc.out;
}

function collectAssertions(s: SpecRunSummary): ReportSpecResult["assertions"] {
  if (!s.report) return null;
  const out: NonNullable<ReportSpecResult["assertions"]> = [];
  for (const file of s.report.testResults) {
    for (const a of file.assertionResults) {
      out.push({
        name: a.fullName,
        status: a.status === "passed" || a.status === "failed" ? a.status : "skipped",
        durationMs: a.duration ?? null,
      });
    }
  }
  return out;
}

/**
 * Compose the failure log for the analysis prompt + report. JSON-reporter
 * vitest writes almost nothing to stdout, so structured failureMessages
 * come first and the raw output tail is appended as secondary context.
 */
export function buildFailureLog(s: SpecRunSummary): string {
  const parts: string[] = [];
  if (s.report) {
    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        if (a.status !== "failed") continue;
        parts.push(`✖ ${a.fullName}`);
        for (const m of a.failureMessages ?? []) parts.push(m);
      }
    }
  }
  const tail = s.outputTail?.trim();
  if (tail) {
    parts.push("--- vitest output (tail) ---");
    parts.push(tail);
  }
  return parts.join("\n");
}

async function readScriptSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function readReport(path: string): Promise<VitestJsonReport | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as VitestJsonReport;
  } catch {
    return null;
  }
}

function printSummary(summaries: SpecRunSummary[]): void {
  log.emitRaw(
    `\n${C.cyan}${C.bold}──────── ccqa summary ────────${C.reset}\n\n`,
  );

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of summaries) {
    const header = `${C.bold}${s.featureName}/${s.specName}${C.reset}`;
    if (!s.report) {
      const ok = s.exitCode === 0;
      const icon = ok ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
      log.emitRaw(`${icon} ${header} ${C.dim}(no report)${C.reset}\n`);
      continue;
    }

    totalTests += s.report.numTotalTests;
    totalPassed += s.report.numPassedTests;
    totalFailed += s.report.numFailedTests;
    totalSkipped += s.report.numPendingTests;

    const ok = s.report.success;
    const icon = ok ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
    const countColor = ok ? C.green : C.red;
    log.emitRaw(
      `${icon} ${header}  ${countColor}${s.report.numPassedTests}/${s.report.numTotalTests}${C.reset} ${C.dim}passed${C.reset}\n`,
    );

    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        const aIcon = assertionIcon(a.status);
        const dur = a.duration != null ? ` ${C.gray}${formatDuration(a.duration)}${C.reset}` : "";
        log.emitRaw(`    ${aIcon} ${a.fullName}${dur}\n`);
        if (a.status === "failed" && a.failureMessages?.length) {
          for (const msg of a.failureMessages) {
            const firstLine = msg.split("\n")[0] ?? msg;
            log.emitRaw(`        ${C.red}${firstLine}${C.reset}\n`);
          }
        }
      }
    }
  }

  const specsPassed = summaries.filter((s) => s.exitCode === 0).length;
  const specsFailed = summaries.filter((s) => s.exitCode !== 0).length;
  log.emitRaw("\n");
  log.emitRaw(
    `  ${C.bold}Specs${C.reset}   ${summaries.length}  ` +
      `(${C.green}${specsPassed} passed${C.reset}, ${specsFailed > 0 ? C.red : C.dim}${specsFailed} failed${C.reset})\n`,
  );
  log.emitRaw(
    `  ${C.bold}Tests${C.reset}   ${totalTests}  ` +
      `(${C.green}${totalPassed} passed${C.reset}, ${totalFailed > 0 ? C.red : C.dim}${totalFailed} failed${C.reset}, ${C.yellow}${totalSkipped} skipped${C.reset})\n`,
  );
  log.emitRaw("\n");
}

function assertionIcon(status: VitestAssertionResult["status"]): string {
  switch (status) {
    case "passed":
      return `${C.green}✔${C.reset}`;
    case "failed":
      return `${C.red}✖${C.reset}`;
    case "skipped":
    case "pending":
    case "todo":
      return `${C.yellow}◌${C.reset}`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const NOISE_LINE_PATTERNS = [/^JSON report written to /];

async function streamFiltered(
  source: Readable,
  sink: { write(chunk: string): void },
  capture?: TailBuffer | null,
): Promise<void> {
  source.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of source) {
    buffer += chunk as string;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!NOISE_LINE_PATTERNS.some((p) => p.test(line))) {
        sink.write(line + "\n");
        capture?.append(line + "\n");
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0 && !NOISE_LINE_PATTERNS.some((p) => p.test(buffer))) {
    sink.write(buffer);
    capture?.append(buffer);
  }
}
