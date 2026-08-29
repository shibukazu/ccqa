import { AGENT_BROWSER_JUDGE_STEPS } from "../targets/agent-browser/judge-steps.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as log from "./logger.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";

import { driftAuthAvailable } from "../drift/auth.ts";
import type { DiffProvider } from "../run/diff-provider.ts";
import { ANALYSIS_DISABLED } from "../run/failure-analysis.ts";
import { analyzeFailure } from "../report/analyze.ts";
import { buildLiveTranscriptExcerpt } from "../report/live-transcript-excerpt.ts";
import { collectIncludedBlockNames, expandActionSteps } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  getSpecDir,
  loadAllBlocks,
  loadAvailableBlocks,
  loadPromptBundleFromHub,
  readSpecFile,
  specKey,
  type AvailableBlock,
} from "../store/index.ts";
import type { HubContext } from "./hub-conn.ts";
import { isStorageStateShape } from "./hub.ts";
import { type AnalysisCustomPrompt, resolveCustomPromptForTarget } from "../prompts/custom-prompt.ts";
import { AGENT_BROWSER_TARGET } from "../spec/yaml-schema.ts";
import { buildProseEnvScrubMap } from "../runtime/env-scrub.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import {
  DEFAULT_SESSION_PROFILE,
  mergeStorageStates,
  removeTempStateDir,
  SESSION_VERIFY_URL_KEY,
  verifySessionRestores,
  writeMergedTempState,
  type SessionRestoreCheck,
  type StorageState,
} from "../runtime/session-state.ts";
import { runPool } from "../runtime/pool.ts";
import { formatLiveCost } from "../runtime/live-cost-format.ts";
import { runLiveExecutor, type LiveRunResult, type LiveStepResult } from "../runtime/live-executor.ts";
import { generateLiveSessionName } from "../prompts/live.ts";
import { liveRunToReportResult } from "../report/live-adapter.ts";
import type { ReportCoverage, ReportSpecResult } from "../report/schema.ts";
import { closeMeasurement, specCoverageDir } from "../coverage/session.ts";
import { acquireAgentBrowserEndpoint } from "../targets/agent-browser/browser-endpoint.ts";
import { errMessage } from "../run/errors.ts";
import type { CoverageCollector } from "../targets/types.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { RunTeardown } from "./run-teardown.ts";
import type { IncrementalReport } from "../run/incremental-report.ts";
import type { GroupLookup } from "../run/serial-groups.ts";
import type { SpecRef } from "../store/index.ts";

/** Result of `driftAuthAvailable()`, hoisted once and shared across workers. */
type DriftAuth = ReturnType<typeof driftAuthAvailable>;

export interface RunLiveOptions {
  model?: string;
  language?: string;
  out?: string;
  reportDir?: string;
  retry?: number;
  /**
   * Per-spec source-diff resolver, present exactly when `--on-fail-explain`
   * was requested (the pipeline resolves the baseline up front). Null/absent
   * disables both the failure classification and the drift audit.
   */
  diffProvider?: DiffProvider | null;
  cwd?: string;
  concurrency?: number;
  /** See `RunnerOptions.resources`. Required: an omitted lookup would drop
   * serialisation silently. */
  resources: GroupLookup;
  /** Active `--hub-profile` name; selects the sessions bucket for `spec.session`. */
  profile?: string;
  hubContext?: HubContext | null;
  customPrompt?: AnalysisCustomPrompt | null;
  /** Human-maintained `triage.user` hub prompt, injected ahead of `customPrompt`. */
  triageUserPrompt?: string | null;
  /** Reaps orphaned agent-browser sessions on SIGINT/SIGTERM. See run-teardown.ts. */
  teardown?: RunTeardown;
  /**
   * When set, each spec upserts its report row and flushes report.json as it
   * finishes (incremental report). Absent (no --report) keeps the legacy
   * behaviour: rows are only returned for the caller's final batch write.
   */
  report?: IncrementalReport;
  /**
   * Coverage for live specs, both halves: the browser through the engine
   * attached to agent-browser's own browser (see runOneSpec), the server
   * through the cookie that attachment plants. Present only under
   * `--coverage`.
   */
  coverage?: CoverageCollector;
}

export type LiveSpecRun = {
  /** ReportSpecResult rows the dispatcher can merge into the unified report.json. */
  reportResults: ReportSpecResult[];
  /** Failed (or unloadable) specs; the dispatcher uses this to set the exit code. */
  failedCount: number;
};

/**
 * Run pre-filtered `mode: live` specs through `runLiveExecutor` (Claude +
 * agent-browser) and, when `reportDir` is set, run drift audit + failure
 * analysis to produce report rows. Sibling of `runDeterministicSpecs`.
 */
/**
 * Brackets one live spec's execution with the measurement.
 *
 * The bracket has to hold even when the spec does not run: opening a turn on an
 * identity and never closing it would leave the next spec waiting on a window
 * that outlived its owner.
 */
async function measureLive<T>(
  spec: SpecRef,
  opts: RunLiveOptions,
  coverageDir: string,
  execute: () => Promise<T>,
): Promise<{ outcome: T; coverage: ReportCoverage | undefined }> {
  const collector = opts.coverage;
  if (collector === undefined) return { outcome: await execute(), coverage: undefined };
  // Recreated per run so a previous run's browser result can't leak into
  // this row — the engine (armed inside `execute`) writes into it.
  await rm(coverageDir, { recursive: true, force: true });
  await mkdir(coverageDir, { recursive: true });
  await collector.beginSpec(spec);
  let outcome: T;
  try {
    outcome = await execute();
  } catch (err) {
    await closeMeasurement(collector, spec, coverageDir);
    throw err;
  }
  return { outcome, coverage: await closeMeasurement(collector, spec, coverageDir) };
}

export async function runLiveSpecs(
  specs: readonly SpecRef[],
  opts: RunLiveOptions,
): Promise<LiveSpecRun> {
  if (specs.length === 0) return { reportResults: [], failedCount: 0 };

  const cwd = opts.cwd ?? process.cwd();
  await preflightAgentBrowserCommand();

  log.meta("live-specs", specs.length);

  const userPromptBundle = await loadPromptBundleFromHub(opts.hubContext ?? null, "live");
  if (userPromptBundle !== null) {
    log.meta("prompt", userPromptBundle.loaded.join(" + "));
  }
  const userPromptSuffix = userPromptBundle?.text ?? null;

  // Both pieces of automated analysis cost Claude turns; they only run when
  // the pipeline resolved an `--on-fail-explain` baseline (diffProvider set).
  // The drift audit is an input to the classification (its findings feed the
  // prompt), so the two are one unit: analysis on means audit on.
  const diffProvider = opts.diffProvider ?? null;
  const failureAnalysisEnabled = diffProvider != null;

  // Failure-analysis auth is spec-independent, so hoist it out of the
  // per-spec worker. The diff and the drift audit only matter for specs that
  // actually fail, so they run lazily inside each worker (see
  // buildLiveReportRow) — the provider memoizes the capture, so N failing
  // specs sharing a baseline still cost one `git diff`.
  const auth: DriftAuth = failureAnalysisEnabled ? driftAuthAvailable() : { ok: false, reason: "disabled" };
  if (failureAnalysisEnabled && !auth.ok) log.info(`failure analysis skipped (${auth.reason})`);

  // Spec-independent like `auth` above — hoisted so N failing specs share one
  // load instead of re-reading `.ccqa/blocks/` per failure.
  const blocks = failureAnalysisEnabled ? await loadAvailableBlocks(cwd) : [];

  const reportDir = opts.reportDir ?? ".";

  // Fresh agent-browser session per spec so Chrome state doesn't bleed across.
  // Above 1 worker each spec buffers its narration and flushes one labelled
  // block on completion, so parallel Chrome sessions stay legible. Each worker
  // executes the spec, builds its report row (drift + failure analysis), and —
  // when an incremental writer is present — upserts+flushes report.json so an
  // interrupt keeps the specs that already finished.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const built = await runPool(specs, concurrency, (spec, i) => {
    const label = `${spec.featureName}/${spec.specName}`;
    return log.withBuffer(label, concurrency > 1, async () => {
      // Sequential runs print a live [i/n] header; parallel runs get the
      // labelled block from withBuffer instead, so skip the header there.
      if (concurrency === 1 && specs.length > 1) {
        log.blank();
        log.info(`[${i + 1}/${specs.length}] ${label}`);
      }
      // Derived once and handed to both halves: the engine writes into the
      // directory `measureLive` recreates and then reads back.
      const coverageDir = specCoverageDir(reportDir, spec.featureName, spec.specName);
      const measured = await measureLive(spec, opts, coverageDir, () =>
        runOneSpec({ ...spec, opts, userPromptSuffix, cwd, coverageDir }),
      );
      const { outcome } = measured;
      if (outcome.kind !== "run") return { outcome, row: null };
      const row = {
        ...(await buildLiveReportRow(outcome, { auth, diffProvider, reportDir, blocks }, opts, cwd)),
        ...(outcome.coverageBroken !== undefined
          ? {
              coverageUnavailable: `could not attach to the live browser: ${outcome.coverageBroken}`,
            }
          : measured.coverage
            ? { coverage: measured.coverage }
            : {}),
      };
      await opts.report?.upsert(row);
      return { outcome, row };
    });
  }, { resources: opts.resources });

  const runs = built.map((b) => b.outcome);
  const failedCount = runs.filter(
    (r) => r.kind === "error" || (r.kind === "run" && r.result.status === "failed"),
  ).length;

  log.blank();
  log.meta(
    "live-summary",
    `${runs.length - failedCount} passed / ${failedCount} failed`,
  );

  return {
    failedCount,
    reportResults: built.flatMap((b) => (b.row ? [b.row] : [])),
  };
}

/**
 * Build one spec's report row: the live-run base row plus (for a failed spec)
 * the failure-analysis fields. Runs inside the pool worker so the row can be
 * upserted incrementally the moment the spec finishes.
 */
async function buildLiveReportRow(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  ctx: {
    auth: DriftAuth;
    diffProvider: DiffProvider | null;
    reportDir: string;
    blocks: AvailableBlock[];
  },
  opts: RunLiveOptions,
  cwd: string,
): Promise<ReportSpecResult> {
  const base = await liveRunToReportResult({
    featureName: r.featureName,
    specName: r.specName,
    specYaml: r.specYaml,
    result: r.result,
    reportDir: ctx.reportDir,
  });
  const analysis =
    ctx.diffProvider && r.result.status === "failed"
      ? await analyzeOneLiveFailure(r, ctx.diffProvider, ctx.auth, ctx.blocks, opts, cwd)
      : undefined;
  return { ...base, ...analysisFieldsFor(analysis, r.result.status) };
}

/**
 * Merge analysis-related fields into the report row. The unattempted-failure
 * branch exists so the report distinguishes "we tried and gave up" (auth /
 * spec.yaml missing) from "we deliberately did not run the classifier" —
 * `a` is undefined for a failed spec exactly when analysis was not requested
 * (no diffProvider), so no separate flag is needed.
 */
function analysisFieldsFor(
  a: LiveFailureAnalysis | undefined,
  status: "passed" | "failed",
): Partial<ReportSpecResult> {
  if (a) {
    return {
      analysis: a.analysis,
      analysisSkipped: a.analysisSkipped,
      failureLogExcerpt: a.failureLogExcerpt,
      diffExcerpt: a.diffExcerpt,
      ...(a.analysisBase ? { analysisBase: a.analysisBase } : {}),
      ...(a.customPromptVersion ? { customPromptVersion: a.customPromptVersion } : {}),
    };
  }
  if (status === "failed") {
    return { analysisSkipped: ANALYSIS_DISABLED };
  }
  return {};
}

type SpecRunOutcome =
  | {
      kind: "run";
      featureName: string;
      specName: string;
      runDir: string;
      specYaml: string;
      /** Carried to the analysis rather than rebuilt there: rebuilding would
       * re-read blocks from disk, which a mid-run edit could have changed. */
      envScrubMap: Array<[string, string]>;
      result: LiveRunResult;
      /**
       * Why the browser engine never attached, when it didn't. The row then
       * says `coverageUnavailable` instead of carrying a server-only result
       * that reads as "the spec reached almost nothing" — the same rule the
       * external runner applies.
       */
      coverageBroken?: string;
    }
  | {
      kind: "error";
      featureName: string;
      specName: string;
      error: string;
    };

type SessionResolution =
  | {
      ok: true;
      statePath: string;
      /**
       * A signed-in verify URL embedded in one of the restored sessions (the
       * first found), passed to the executor so a daemon restart mid-run can be
       * detected and recovered from. Absent when no session carried one.
       */
      verifyUrl?: string;
      cleanup: () => Promise<void>;
    }
  | { ok: false; error: string; hint: string };

/**
 * Sessions whose restore has already been health-checked this process, keyed
 * `<profile>/<name>`. A run of many specs restores the same session repeatedly;
 * we only open a throwaway verify browser the first time.
 */
const verifiedSessions = new Set<string>();

/**
 * Resolve `spec.session` names to a single state file to restore, fetching
 * each named session from the hub (`.ccqa/sessions/*.json` is no longer
 * read here). Every name must load as a valid agent-browser state (the spec
 * assumes it starts signed-in); a missing/malformed session fails with a
 * `ccqa hub session capture` hint instead of running unauthenticated.
 *
 * If a session carries an embedded verify URL (bootstrap saved it), the
 * restore is health-checked before the run starts, so an expired/unusable
 * session fails fast with a re-bootstrap hint instead of every step failing
 * generically. Loaded states are always merged (even a single one) and written
 * to a fresh temp file — callers must invoke the returned `cleanup()` once the
 * run is done. `verify` is injectable for tests.
 */
export async function resolveSessionState(
  names: readonly string[],
  hubCtx: HubContext | null,
  profile: string | undefined,
  verify: (statePath: string, url: string) => SessionRestoreCheck = verifySessionRestores,
): Promise<SessionResolution> {
  if (names.length === 0 || hubCtx === null) {
    const list = names.join(", ");
    return {
      ok: false,
      error: `session '${list}' requires a hub connection`,
      hint: "set --hub-url/--hub-token (or CCQA_HUB_URL/CCQA_HUB_TOKEN) to restore sessions from the hub",
    };
  }

  const resolvedProfile = profile ?? DEFAULT_SESSION_PROFILE;
  const profileFlag = profile ? ` --profile ${profile}` : "";
  const loaded: StorageState[] = [];
  const broken: string[] = [];
  // First verify URL seen across the requested sessions; the executor uses it
  // as the signed-in anchor for mid-run daemon-restart recovery. Any one is
  // enough — a restart drops the whole merged state at once, so re-injecting
  // restores every provider and re-opening one anchor proves the session is
  // signed in again.
  let verifyUrl: string | undefined;
  for (const name of names) {
    let state: unknown;
    try {
      state = await hubCtx.hub.getSession(hubCtx.project, resolvedProfile, name);
    } catch {
      broken.push(name);
      continue;
    }
    if (!isStorageStateShape(state)) {
      broken.push(name);
      continue;
    }

    const embedded = (state as Record<string, unknown>)[SESSION_VERIFY_URL_KEY];
    if (typeof embedded === "string") {
      verifyUrl ??= embedded;
      const memoKey = `${resolvedProfile}/${name}`;
      if (!verifiedSessions.has(memoKey)) {
        // Health-check this session's restore before the run. mergeStorageStates
        // rebuilds {cookies, origins}, so the embedded key is stripped and never
        // reaches agent-browser.
        const tmp = await writeMergedTempState(mergeStorageStates([state as StorageState]));
        const check = verify(tmp, embedded);
        await removeTempStateDir(tmp);
        if (!check.restored) {
          return {
            ok: false,
            error: `session '${name}' did not restore to a signed-in page — ${check.reason}`,
            hint: `re-bootstrap it: ccqa hub session capture ${name}${profileFlag}`,
          };
        }
        verifiedSessions.add(memoKey);
      }
    } else {
      log.warn(
        `session '${name}' has no embedded verify URL (saved by an older ccqa) — skipping the pre-run restore check`,
      );
    }

    loaded.push(state as StorageState);
  }

  if (broken.length > 0) {
    return {
      ok: false,
      error: `session not usable on the hub: ${broken.join(", ")}`,
      hint: `create it with: ${broken.map((name) => `ccqa hub session capture ${name}${profileFlag}`).join("  ·  ")}`,
    };
  }

  const statePath = await writeMergedTempState(mergeStorageStates(loaded));
  return {
    ok: true,
    statePath,
    ...(verifyUrl ? { verifyUrl } : {}),
    cleanup: () => removeTempStateDir(statePath),
  };
}

async function runOneSpec(args: {
  featureName: string;
  specName: string;
  opts: RunLiveOptions;
  userPromptSuffix: string | null;
  cwd: string;
  /** Where the acquisition engine writes; the caller reads it back after. */
  coverageDir: string;
}): Promise<SpecRunOutcome> {
  const { featureName, specName, opts, userPromptSuffix, cwd, coverageDir } = args;
  const specDir = getSpecDir(featureName, specName, cwd);

  let specContent: string;
  try {
    specContent = await readSpecFile(featureName, specName, cwd);
  } catch (err) {
    log.error(`failed to read spec: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "error", featureName, specName, error: String(err) };
  }

  const spec = parseTestSpec(specContent);
  const blocks = await loadAllBlocks(cwd);
  const steps = expandActionSteps(spec, { blocks }, `${featureName}/${specName}`, {
    id: AGENT_BROWSER_TARGET,
    reason: AGENT_BROWSER_JUDGE_STEPS.reason,
  });

  log.meta("spec", spec.title);
  log.meta("steps", steps.length);
  const includes = collectIncludedBlockNames(spec);
  if (includes.length > 0) log.meta("blocks", includes.join(", "));

  // Every run uses a fresh ephemeral session name. Pre-authenticated state
  // (cookies + localStorage) is brought in separately via `spec.session` and
  // restored into the session read-only before the run starts (see the live
  // executor), so re-running the spec — locally or in CI — never mutates the
  // source-of-truth state files.
  const sessionName = generateLiveSessionName();
  log.meta("session", sessionName);
  opts.teardown?.trackSession(sessionName);

  // Restore any sessions named by `spec.session` from the hub (see
  // resolveSessionState); a missing one stops the run rather than starting
  // unauthenticated. The resolved state always lives in a temp file, cleaned
  // up in the `finally` below once the run (pass, fail, or throw) is done.
  let statePath: string | null = null;
  let verifyUrl: string | null = null;
  let cleanupSession: (() => Promise<void>) | null = null;
  if (spec.session && spec.session.length > 0) {
    const resolution = await resolveSessionState(spec.session, opts.hubContext ?? null, opts.profile);
    if (!resolution.ok) {
      log.error(resolution.error);
      log.hint(resolution.hint);
      return { kind: "error", featureName, specName, error: resolution.error };
    }
    statePath = resolution.statePath;
    verifyUrl = resolution.verifyUrl ?? null;
    cleanupSession = resolution.cleanup;
    log.meta("state", spec.session.join(", "));
  }

  // Under --coverage, the shared acquisition engine attaches to this spec's
  // browser before the agent starts driving it. The session was created just
  // above and its browser pre-warmed by the acquisition, so state restored by
  // the executor lands in a warm browser — the executor's own recovery shape.
  // Failure is loud on the log but does not stop the spec: the run was asked
  // for, the measurement was not what makes it useful.
  let browserEngine: { stop(): Promise<void> } | undefined;
  let coverageBroken: string | undefined;
  if (opts.coverage) {
    try {
      const handle = await acquireAgentBrowserEndpoint({
        cwd,
        featureName,
        specName,
        driverSession: sessionName,
      });
      browserEngine = await opts.coverage.armBrowser({ featureName, specName }, handle, coverageDir);
    } catch (err) {
      coverageBroken = errMessage(err);
      log.warn(`coverage: could not attach to the live browser (${coverageBroken})`);
    }
  }

  try {
    const runId = buildRunId();
    // Built after the run id exists: the executor injects CCQA_RUN_ID into
    // the child, so the map must scrub against that value, not whatever the
    // parent env holds. (The environment itself is stable: a profile is
    // applied once per invocation, before any spec runs.)
    const envScrubMap = buildProseEnvScrubMap(spec, steps, { CCQA_RUN_ID: runId });
    const runDir = opts.out ?? join(specDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    log.meta("runDir", runDir);

    const result = await runLiveExecutor({
      spec: { title: spec.title },
      steps,
      runId,
      runDir,
      sessionName,
      envScrubMap,
      statePath,
      verifyUrl,
      systemPromptSuffix: userPromptSuffix,
      model: opts.model,
      language: opts.language,
      retries: opts.retry,
    });

    const runJsonPath = join(runDir, "run.json");
    const runMdPath = join(runDir, "run.md");
    await writeFile(runJsonPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
    await writeFile(runMdPath, renderRunMarkdown(featureName, specName, result), "utf-8");

    log.meta("saved", runJsonPath);
    log.meta("status", result.status.toUpperCase());
    log.meta(
      "step-summary",
      `${count(result.steps, "passed")} passed / ${count(result.steps, "failed")} failed / ${count(result.steps, "skipped")} skipped`,
    );
    const costLine = formatLiveCost(result.cost, { compact: false });
    if (costLine) log.meta("cost", costLine);

    return {
      kind: "run",
      featureName,
      specName,
      runDir,
      specYaml: specContent,
      envScrubMap,
      result,
      ...(coverageBroken === undefined ? {} : { coverageBroken }),
    };
  } finally {
    // The engine's final take needs the browser, so it stops strictly before
    // the session is closed — this ordering is what makes live measurement
    // lossless where the external-runner path can only bound the tail.
    if (browserEngine) await browserEngine.stop().catch(() => undefined);
    if (cleanupSession) await cleanupSession();
    opts.teardown?.untrackSession(sessionName);
    // Close the agent-browser session now that the spec is done — otherwise
    // it lingers as an orphaned daemon process.
    await closeSession(sessionName);
  }
}

type LiveFailureAnalysis = {
  analysis: ReportSpecResult["analysis"];
  analysisSkipped: string | null;
  failureLogExcerpt: string | null;
  diffExcerpt: string | null;
  /** The baseline this spec's diff was taken against; absent when no diff was resolved. */
  analysisBase?: { ref: string; sha: string };
  /** The overlay version actually applied to this row; absent when none was injected. */
  customPromptVersion?: string;
};

/**
 * Classify one failed live run via `analyzeFailure` — same prompt as the
 * deterministic path (Issue #47), fed the live transcript instead of the
 * vitest log. `auth` is hoisted once by the caller; the diff comes from the
 * shared provider, already truncated (the live path used to feed the whole
 * untruncated patch — in a monorepo that ballooned the prompt). Auth-unavailable
 * / no-failed-step degrade to `analysisSkipped` rather than throwing.
 */
async function analyzeOneLiveFailure(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  diffProvider: DiffProvider,
  auth: DriftAuth,
  blocks: AvailableBlock[],
  opts: RunLiveOptions,
  cwd: string,
): Promise<LiveFailureAnalysis> {
  const key = `${r.featureName}/${r.specName}`;
  if (!auth.ok) {
    return { analysis: null, analysisSkipped: auth.reason, failureLogExcerpt: null, diffExcerpt: null };
  }
  log.info(`failure analysis: ${key}`);
  const excerpt = await buildLiveTranscriptExcerpt(r.result);
  if (excerpt === null) {
    return {
      analysis: null,
      analysisSkipped: "no failed step found in run result",
      failureLogExcerpt: null,
      diffExcerpt: null,
    };
  }
  const specDiffResult = await diffProvider.forSpec({ featureName: r.featureName, specName: r.specName });
  // No usable baseline for THIS spec (last-green: never green yet, or its
  // commit isn't fetched) — still classify, from the transcript plus
  // current-repository inspection (the prompt's no-baseline mode).
  const specDiff = specDiffResult.ok ? specDiffResult : null;
  const baselineMissing = specDiffResult.ok ? null : specDiffResult.skip;
  if (baselineMissing) {
    log.info(`failure analysis: no baseline (${baselineMissing}) — classifying from current source`);
  } else if (specDiff?.error) {
    log.info(`failure analysis: source diff unavailable (${specDiff.error}) — analyzing without diff context`);
  }
  // Live specs are always the agent-browser target, so select that overlay.
  const customPrompt = resolveCustomPromptForTarget(opts.customPrompt, AGENT_BROWSER_TARGET);
  const outcome = await analyzeFailure(
    {
      liveTranscriptExcerpt: excerpt,
      // A `mode: live` spec has no compiled surface — it IS the test that ran.
      hasGeneratedSurface: false,
      blocks,
      specYaml: r.specYaml,
      diffPatch: specDiff?.patch ?? null,
      changedFiles: specDiff?.nameStatus ?? null,
      baseRef: specDiff?.base.ref ?? null,
      baseSource: specDiff?.base.source ?? null,
      range: specDiff?.range ?? null,
      ...(baselineMissing ? { baselineMissing } : {}),
      ...(opts.language ? { outputLanguage: opts.language } : {}),
      ...(opts.triageUserPrompt ? { triageUserPrompt: opts.triageUserPrompt } : {}),
      ...(customPrompt ? { customPrompt } : {}),
    },
    {
      ...(opts.model ? { model: opts.model } : {}),
      cwd,
      getFileDiff: specDiff?.fileDiff ?? (() => null),
      envScrubMap: r.envScrubMap,
    },
  );
  const pct = Math.round(outcome.analysis.confidence * 100);
  const headline = outcome.analysis.headline.trim() || (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
  log.info(`  → ${outcome.analysis.label} (${pct}%) ${headline}`);
  return {
    analysis: outcome.analysis,
    analysisSkipped: null,
    failureLogExcerpt: excerpt,
    diffExcerpt: specDiff?.patch ?? null,
    ...(specDiff ? { analysisBase: { ref: specDiff.base.ref, sha: specDiff.base.sha } } : {}),
    ...(customPrompt ? { customPromptVersion: customPrompt.customPromptVersion } : {}),
  };
}

function count(steps: LiveStepResult[], target: LiveStepResult["status"]): number {
  return steps.filter((s) => s.status === target).length;
}

function renderRunMarkdown(featureName: string, specName: string, result: LiveRunResult): string {
  const head = [
    `# live run: ${featureName}/${specName}`,
    "",
    `- runId: ${result.runId}`,
    `- session: ${result.sessionName}`,
    `- startedAt: ${result.startedAt}`,
    `- duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- status: ${result.status}`,
    "",
  ].join("\n");

  const stepSections = result.steps
    .map((s) =>
      [
        `## ${s.stepId} — ${s.status}`,
        `- duration: ${(s.durationMs / 1000).toFixed(1)}s`,
        `- instruction: ${oneLine(s.instruction)}`,
        `- expected: ${oneLine(s.expected)}`,
        `- reasoning: ${oneLine(s.reasoning)}`,
        ...(s.beforePng ? [`- before: ${s.beforePng}`] : []),
        ...(s.afterPng ? [`- after: ${s.afterPng}`] : []),
        "",
      ].join("\n"),
    )
    .join("\n");

  return head + stepSections;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
