import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as log from "./logger.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";

import { analyzeDrift } from "../drift/analyze.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import { resolveBaseRef } from "../drift/affected.ts";
import { capturePrDiff, type PrDiffResult } from "../report/diff.ts";
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
  writeMergedTempState,
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
  driftAudit?: boolean;
  failureAnalysis?: boolean;
  base?: string;
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

  // Both pieces of automated analysis cost Claude turns. They run by default
  // (a report is always written); disabling the failure analysis implicitly
  // disables the drift audit too (the audit is rendered as supporting evidence
  // under the classification). --no-drift-audit remains independent for
  // "classify but skip the audit".
  const failureAnalysisEnabled = opts.failureAnalysis !== false;
  const driftAuditEnabled = failureAnalysisEnabled && opts.driftAudit !== false;

  // Drift audit, failure-analysis auth, and the source diff are all
  // spec-independent, so hoist them out of the per-spec worker and compute them
  // once before the pool. Drift is a static spec↔code audit (it only needs the
  // spec ids, not run results), so running it up front lets each worker classify
  // its own failure inline with the drift context already in hand — which is
  // what makes the incremental per-spec upsert possible.
  const driftBySpec = driftAuditEnabled
    ? await runDriftAudit(specs, opts, cwd)
    : new Map<string, ReportSpecResult["driftIssues"]>();
  const auth: DriftAuth = failureAnalysisEnabled ? driftAuthAvailable() : { ok: false, reason: "disabled" };
  if (failureAnalysisEnabled && !auth.ok) log.info(`failure analysis skipped (${auth.reason})`);
  const baseRef = resolveBaseRef(opts.base);
  let diff: PrDiffResult = { ok: false, error: "diff not captured" };
  if (failureAnalysisEnabled && auth.ok) {
    diff = await capturePrDiff(baseRef, cwd);
    if (!diff.ok) {
      log.info(`failure analysis: source diff unavailable (${diff.error}) — analyzing without diff context`);
    }
  }

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
        { driftBySpec, auth, diff, baseRef, reportDir, failureAnalysisEnabled },
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
 * Build one spec's report row: the live-run base row plus drift findings and
 * (for a failed spec) the failure-analysis fields. Runs inside the pool worker
 * so the row can be upserted incrementally the moment the spec finishes.
 */
async function buildLiveReportRow(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  ctx: {
    driftBySpec: Map<string, ReportSpecResult["driftIssues"]>;
    auth: DriftAuth;
    diff: PrDiffResult;
    baseRef: string;
    reportDir: string;
    failureAnalysisEnabled: boolean;
  },
  opts: RunLiveOptions,
  cwd: string,
): Promise<ReportSpecResult> {
  const key = `${r.featureName}/${r.specName}`;
  const driftForSpec = ctx.driftBySpec.get(key) ?? null;
  const base = await liveRunToReportResult({
    featureName: r.featureName,
    specName: r.specName,
    specYaml: r.specYaml,
    result: r.result,
    reportDir: ctx.reportDir,
  });
  const analysis =
    ctx.failureAnalysisEnabled && r.result.status === "failed"
      ? await analyzeOneLiveFailure(r, ctx.diff, ctx.baseRef, driftForSpec, ctx.auth, opts, cwd)
      : undefined;
  return {
    ...base,
    driftIssues: driftForSpec,
    ...analysisFieldsFor(analysis, r.result.status, ctx.failureAnalysisEnabled),
  };
}

/**
 * Merge analysis-related fields into the report row. The unattempted-failure
 * branch exists so the report distinguishes "we tried and gave up" (auth /
 * spec.yaml missing) from "we deliberately did not run the classifier".
 */
function analysisFieldsFor(
  a: LiveFailureAnalysis | undefined,
  status: "passed" | "failed",
  failureAnalysisEnabled: boolean,
): Partial<ReportSpecResult> {
  if (a) {
    return {
      analysis: a.analysis,
      analysisSkipped: a.analysisSkipped,
      failureLogExcerpt: a.failureLogExcerpt,
      diffExcerpt: a.diffExcerpt,
    };
  }
  if (!failureAnalysisEnabled && status === "failed") {
    return { analysisSkipped: "skipped by --no-failure-analysis" };
  }
  return {};
}

/**
 * Run `analyzeDrift` against every spec and return a
 * `featureName/specName → driftIssues` map. This is a static spec↔code audit,
 * so it takes the spec list directly and runs before execution — each worker
 * then has its spec's drift context in hand for the failure-analysis prompt.
 * Drift findings are advisory — they show in the report (report.json / hub UI)
 * but do not change the live-run exit code.
 */
async function runDriftAudit(
  specs: readonly { featureName: string; specName: string }[],
  opts: RunLiveOptions,
  cwd: string,
): Promise<Map<string, ReportSpecResult["driftIssues"]>> {
  const targets = specs.map((s) => ({ featureName: s.featureName, specName: s.specName }));
  const out = new Map<string, ReportSpecResult["driftIssues"]>();
  if (targets.length === 0) return out;

  log.blank();
  log.info(`drift audit: ${targets.length} spec${targets.length > 1 ? "s" : ""}`);
  const blocks = await loadAvailableBlocks(cwd);
  const results = await analyzeDrift({
    targets,
    cwd,
    blocks,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    onSpecStart: (t) => log.info(`  checking ${t.featureName}/${t.specName}`),
  });
  for (const r of results) {
    const key = `${r.target.featureName}/${r.target.specName}`;
    if (r.ok) {
      out.set(key, r.issues.length > 0 ? r.issues : null);
    } else {
      log.warn(`drift audit failed for ${key}: ${r.error}`);
      out.set(key, null);
    }
  }
  return out;
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
 * Resolve `spec.session` names to a single state file to restore, fetching
 * each named session from the hub (`.ccqa/sessions/*.json` is no longer
 * read here). Every name must load as a valid agent-browser state (the spec
 * assumes it starts signed-in); a missing/malformed session fails with a
 * `ccqa session bootstrap` hint instead of running unauthenticated. Loaded
 * states are always merged (even a single one) and written to a fresh temp
 * file — callers must invoke the returned `cleanup()` once the run is done.
 */
export async function resolveSessionState(
  names: readonly string[],
  hubCtx: HubContext | null,
  profile: string | undefined,
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
    loaded.push(state as StorageState);
  }

  if (broken.length > 0) {
    const profileFlag = profile ? ` --profile ${profile}` : "";
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
};

/**
 * Classify one failed live run via `analyzeFailure` — same prompt as the
 * deterministic path (Issue #47), fed the live transcript instead of the
 * vitest log. `auth`, `diff`, and `baseRef` are hoisted once by the caller and
 * shared across specs. Auth-unavailable / no-failed-step degrade to
 * `analysisSkipped` rather than throwing.
 */
async function analyzeOneLiveFailure(
  r: Extract<SpecRunOutcome, { kind: "run" }>,
  diff: PrDiffResult,
  baseRef: string,
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
  const outcome = await analyzeFailure(
    {
      liveTranscriptExcerpt: excerpt,
      specYaml: r.specYaml,
      diffPatch: diff.ok ? diff.diff.patch : null,
      changedFiles: diff.ok ? diff.diff.nameStatus : null,
      baseRef: diff.ok ? baseRef : null,
      driftIssues: driftForSpec,
      ...(opts.language ? { outputLanguage: opts.language } : {}),
      ...(opts.triageUserPrompt ? { triageUserPrompt: opts.triageUserPrompt } : {}),
      ...(opts.customPrompt ? { customPrompt: opts.customPrompt } : {}),
    },
    { ...(opts.model ? { model: opts.model } : {}), cwd },
  );
  const pct = Math.round(outcome.analysis.confidence * 100);
  const headline = outcome.analysis.headline.trim() || (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
  log.info(`  → ${outcome.analysis.label} (${pct}%) ${headline}`);
  return {
    analysis: outcome.analysis,
    analysisSkipped: null,
    failureLogExcerpt: excerpt,
    diffExcerpt: diff.ok ? diff.diff.patch : null,
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
