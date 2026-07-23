import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as log from "./logger.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";

import { analyzeDrift } from "../drift/analyze.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import type { DiffProvider } from "../run/diff-provider.ts";
import { ANALYSIS_DISABLED } from "../run/failure-analysis.ts";
import { analyzeFailure } from "../report/analyze.ts";
import { buildLiveTranscriptExcerpt } from "../report/live-transcript-excerpt.ts";
import { collectIncludedBlockNames, expandSpec } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  getSpecDir,
  loadAllBlocks,
  loadAvailableBlocks,
  loadPromptBundleFromHub,
  readSpecFile,
} from "../store/index.ts";
import type { HubContext } from "./hub-conn.ts";
import { isStorageStateShape } from "./hub.ts";
import type { AnalysisCustomPrompt } from "../prompts/custom-prompt.ts";
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
import { formatLiveBatchCost, formatLiveCost } from "../runtime/live-cost-format.ts";
import { runLiveExecutor, type LiveRunResult, type LiveStepResult } from "../runtime/live-executor.ts";
import { generateLiveSessionName } from "../prompts/live.ts";
import { liveRunToReportResult } from "../report/live-adapter.ts";
import type { ReportSpecResult } from "../report/schema.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import type { RunTeardown } from "./run-teardown.ts";
import type { IncrementalReport } from "../run/incremental-report.ts";

/** Result of `driftAuthAvailable()`, hoisted once and shared across workers. */
type DriftAuth = ReturnType<typeof driftAuthAvailable>;

export interface RunLiveOptions {
  model?: string;
  language?: string;
  out?: string;
  reportDir?: string;
  retry?: number;
  /**
   * Per-spec source-diff resolver, present exactly when `--failure-analysis`
   * was requested (the pipeline resolves the baseline up front). Null/absent
   * disables both the failure classification and the drift audit.
   */
  diffProvider?: DiffProvider | null;
  cwd?: string;
  concurrency?: number;
  /** Active `--profile` name; selects the sessions bucket for `spec.session`. */
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
export async function runLiveSpecs(
  specs: readonly { featureName: string; specName: string }[],
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
  // the pipeline resolved a `--failure-analysis` baseline (diffProvider set).
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
      const outcome = await runOneSpec({ ...spec, opts, userPromptSuffix, cwd });
      if (outcome.kind !== "run") return { outcome, row: null };
      const row = await buildLiveReportRow(
        outcome,
        { auth, diffProvider, reportDir },
        opts,
        cwd,
      );
      await opts.report?.upsert(row);
      return { outcome, row };
    });
  });

  const runs = built.map((b) => b.outcome);
  const failedCount = runs.filter(
    (r) => r.kind === "error" || (r.kind === "run" && r.result.status === "failed"),
  ).length;

  log.blank();
  log.meta(
    "live-summary",
    `${runs.length - failedCount} passed / ${failedCount} failed`,
  );
  logBatchCost(runs);

  return {
    failedCount,
    reportResults: built.flatMap((b) => (b.row ? [b.row] : [])),
  };
}

/**
 * Build one spec's report row: the live-run base row plus (for a failed spec)
 * the drift audit and failure-analysis fields. Runs inside the pool worker so
 * the row can be upserted incrementally the moment the spec finishes. The
 * drift audit only runs for failed specs — passing specs get no driftIssues,
 * matching the deterministic path.
 */
async function buildLiveReportRow(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  ctx: {
    auth: DriftAuth;
    diffProvider: DiffProvider | null;
    reportDir: string;
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
  const driftForSpec =
    ctx.diffProvider && r.result.status === "failed" ? await runDriftAuditOne(r, opts, cwd) : null;
  const analysis =
    ctx.diffProvider && r.result.status === "failed"
      ? await analyzeOneLiveFailure(r, ctx.diffProvider, driftForSpec, ctx.auth, opts, cwd)
      : undefined;
  return {
    ...base,
    driftIssues: driftForSpec,
    ...analysisFieldsFor(analysis, r.result.status),
  };
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
    };
  }
  if (status === "failed") {
    return { analysisSkipped: ANALYSIS_DISABLED };
  }
  return {};
}

/**
 * Run `analyzeDrift` for one failed spec, used as evidence for its
 * failure-analysis prompt and shown in its report row. Mirrors the
 * deterministic path (src/run/pipeline.ts), which also scopes the audit to
 * failed specs only. Drift findings are advisory — they never change the
 * live-run exit code.
 */
async function runDriftAuditOne(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  opts: RunLiveOptions,
  cwd: string,
): Promise<ReportSpecResult["driftIssues"]> {
  const key = `${r.featureName}/${r.specName}`;
  log.info(`drift audit: ${key}`);
  const blocks = await loadAvailableBlocks(cwd);
  const [result] = await analyzeDrift({
    targets: [{ featureName: r.featureName, specName: r.specName }],
    cwd,
    blocks,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
  });
  if (!result || !result.ok) {
    log.warn(`drift audit failed for ${key}: ${result?.error ?? "no result"}`);
    return null;
  }
  return result.issues.length > 0 ? result.issues : null;
}

type SpecRunOutcome =
  | {
      kind: "run";
      featureName: string;
      specName: string;
      runDir: string;
      specYaml: string;
      result: LiveRunResult;
    }
  | {
      kind: "error";
      featureName: string;
      specName: string;
      error: string;
    };

type SessionResolution =
  | { ok: true; statePath: string; cleanup: () => Promise<void> }
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
 * `ccqa session bootstrap` hint instead of running unauthenticated.
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
            hint: `re-bootstrap it: ccqa session bootstrap ${name}${profileFlag}`,
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
      hint: `create it with: ${broken.map((name) => `ccqa session bootstrap ${name}${profileFlag}`).join("  ·  ")}`,
    };
  }

  const statePath = await writeMergedTempState(mergeStorageStates(loaded));
  return { ok: true, statePath, cleanup: () => removeTempStateDir(statePath) };
}

async function runOneSpec(args: {
  featureName: string;
  specName: string;
  opts: RunLiveOptions;
  userPromptSuffix: string | null;
  cwd: string;
}): Promise<SpecRunOutcome> {
  const { featureName, specName, opts, userPromptSuffix, cwd } = args;
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
  const expanded = expandSpec(spec, { blocks });

  log.meta("spec", spec.title);
  log.meta("steps", expanded.length);
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
  let cleanupSession: (() => Promise<void>) | null = null;
  if (spec.session && spec.session.length > 0) {
    const resolution = await resolveSessionState(spec.session, opts.hubContext ?? null, opts.profile);
    if (!resolution.ok) {
      log.error(resolution.error);
      log.hint(resolution.hint);
      return { kind: "error", featureName, specName, error: resolution.error };
    }
    statePath = resolution.statePath;
    cleanupSession = resolution.cleanup;
    log.meta("state", spec.session.join(", "));
  }

  try {
    const runId = buildRunId();
    const runDir = opts.out ?? join(specDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    log.meta("runDir", runDir);

    const result = await runLiveExecutor({
      spec: { title: spec.title },
      steps: expanded,
      runId,
      runDir,
      sessionName,
      statePath,
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
      result,
    };
  } finally {
    if (cleanupSession) await cleanupSession();
    opts.teardown?.untrackSession(sessionName);
    // Close the agent-browser session now that the spec is done — otherwise
    // it lingers as an orphaned daemon process.
    await closeSession(sessionName);
  }
}

function logBatchCost(runs: SpecRunOutcome[]): void {
  const costs = runs.flatMap((r) => (r.kind === "run" ? [r.result.cost] : []));
  const line = formatLiveBatchCost(costs);
  if (line) log.meta("total-cost", line);
}

type LiveFailureAnalysis = {
  analysis: ReportSpecResult["analysis"];
  analysisSkipped: string | null;
  failureLogExcerpt: string | null;
  diffExcerpt: string | null;
  /** The baseline this spec's diff was taken against; absent when no diff was resolved. */
  analysisBase?: { ref: string; sha: string };
};

/**
 * Classify one failed live run via `analyzeFailure` — same prompt as the
 * deterministic path (Issue #47), fed the live transcript instead of the
 * vitest log. `auth` is hoisted once by the caller; the diff comes from the
 * shared provider, already scoped to this spec's relatedPaths and truncated
 * (the live path used to feed the whole unscoped patch — in a monorepo that
 * ballooned the prompt with unrelated changes). Auth-unavailable /
 * no-failed-step degrade to `analysisSkipped` rather than throwing.
 */
async function analyzeOneLiveFailure(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  diffProvider: DiffProvider,
  driftForSpec: ReportSpecResult["driftIssues"],
  auth: DriftAuth,
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
  const specDiff = await diffProvider.forSpec({ featureName: r.featureName, specName: r.specName });
  if (!specDiff.ok) {
    // No usable baseline for THIS spec (last-green: never green yet, or its
    // commit isn't fetched) — withhold the classification honestly.
    return { analysis: null, analysisSkipped: specDiff.skip, failureLogExcerpt: excerpt, diffExcerpt: null };
  }
  if (specDiff.error) {
    log.info(`failure analysis: source diff unavailable (${specDiff.error}) — analyzing without diff context`);
  }
  const outcome = await analyzeFailure(
    {
      liveTranscriptExcerpt: excerpt,
      specYaml: r.specYaml,
      diffPatch: specDiff.patch,
      changedFiles: specDiff.nameStatus,
      baseRef: specDiff.base.ref,
      baseSource: specDiff.base.source,
      range: specDiff.range,
      driftIssues: driftForSpec,
      ...(opts.language ? { outputLanguage: opts.language } : {}),
      ...(opts.triageUserPrompt ? { triageUserPrompt: opts.triageUserPrompt } : {}),
      ...(opts.customPrompt ? { customPrompt: opts.customPrompt } : {}),
    },
    { ...(opts.model ? { model: opts.model } : {}), cwd, getFileDiff: specDiff.fileDiff },
  );
  const pct = Math.round(outcome.analysis.confidence * 100);
  const headline = outcome.analysis.headline.trim() || (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
  log.info(`  → ${outcome.analysis.label} (${pct}%) ${headline}`);
  return {
    analysis: outcome.analysis,
    analysisSkipped: null,
    failureLogExcerpt: excerpt,
    diffExcerpt: specDiff.patch,
    analysisBase: { ref: specDiff.base.ref, sha: specDiff.base.sha },
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
