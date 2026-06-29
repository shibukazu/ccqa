import { access, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

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
  loadLivePromptBundle,
  readSpecFile,
} from "../store/index.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { formatLiveBatchCost, formatLiveCost } from "../runtime/live-cost-format.ts";
import { runLiveExecutor, type LiveRunResult, type LiveStepResult } from "../runtime/live-executor.ts";
import { generateLiveSessionName } from "../prompts/live.ts";
import { liveRunToReportResult } from "../report/live-adapter.ts";
import type { ReportSpecResult } from "../report/schema.ts";

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
}

export type LiveSpecRun = {
  /** ReportSpecResult rows the dispatcher can merge into the unified HTML. */
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

  const userPromptBundle = await loadLivePromptBundle(cwd);
  if (userPromptBundle !== null) {
    log.meta("prompt", userPromptBundle.loaded.join(" + "));
  }
  const userPromptSuffix = userPromptBundle?.text ?? null;

  // Fresh agent-browser session per spec so Chrome state doesn't bleed across.
  // Above 1 worker each spec buffers its narration and flushes one labelled
  // block on completion, so parallel Chrome sessions stay legible.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const runs = await runPool(specs, concurrency, (spec, i) => {
    const label = `${spec.featureName}/${spec.specName}`;
    return log.withBuffer(label, concurrency > 1, () => {
      // Sequential runs print a live [i/n] header; parallel runs get the
      // labelled block from withBuffer instead, so skip the header there.
      if (concurrency === 1 && specs.length > 1) {
        log.blank();
        log.info(`[${i + 1}/${specs.length}] ${label}`);
      }
      return runOneSpec({ ...spec, opts, userPromptSuffix, cwd });
    });
  });

  const failedCount = runs.filter(
    (r) => r.kind === "error" || (r.kind === "run" && r.result.status === "failed"),
  ).length;

  log.blank();
  log.meta(
    "live-summary",
    `${runs.length - failedCount} passed / ${failedCount} failed`,
  );
  logBatchCost(runs);

  // Both pieces of automated analysis cost Claude turns. Disabling the
  // failure analysis implicitly disables the drift audit too (the audit
  // is rendered as supporting evidence under the classification).
  // --no-drift-audit remains independent for "classify but skip the audit".
  const failureAnalysisEnabled = opts.reportDir != null && opts.failureAnalysis !== false;
  const driftAuditEnabled = failureAnalysisEnabled && opts.driftAudit !== false;
  const driftBySpec = driftAuditEnabled
    ? await runDriftAudit(runs, opts, cwd)
    : new Map<string, ReportSpecResult["driftIssues"]>();

  const analysisBySpec = failureAnalysisEnabled
    ? await runFailureAnalysisForLiveRuns(runs, driftBySpec, opts, cwd)
    : new Map<string, LiveFailureAnalysis>();

  const reportDir = opts.reportDir ?? ".";
  return {
    failedCount,
    reportResults: buildLiveReportResults(runs, driftBySpec, analysisBySpec, reportDir, failureAnalysisEnabled),
  };
}

function buildLiveReportResults(
  runs: SpecRunOutcome[],
  driftBySpec: Map<string, ReportSpecResult["driftIssues"]>,
  analysisBySpec: Map<string, LiveFailureAnalysis>,
  reportDir: string,
  failureAnalysisEnabled: boolean,
): ReportSpecResult[] {
  return runs.flatMap((r) => {
    if (r.kind !== "run") return [];
    const key = `${r.featureName}/${r.specName}`;
    const base = liveRunToReportResult({
      featureName: r.featureName,
      specName: r.specName,
      specYaml: r.specYaml,
      result: r.result,
      reportDir,
    });
    return [{
      ...base,
      driftIssues: driftBySpec.get(key) ?? null,
      ...analysisFieldsFor(analysisBySpec.get(key), r.result.status, failureAnalysisEnabled),
    }];
  });
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
 * Run `analyzeDrift` against every successfully-loaded spec and return a
 * `featureName/specName → driftIssues` map. Drift findings are advisory —
 * they show in the HTML report but do not change the live-run exit code.
 */
async function runDriftAudit(
  runs: SpecRunOutcome[],
  opts: RunLiveOptions,
  cwd: string,
): Promise<Map<string, ReportSpecResult["driftIssues"]>> {
  const targets = runs
    .filter((r): r is Extract<SpecRunOutcome, { kind: "run" }> => r.kind === "run")
    .map((r) => ({ featureName: r.featureName, specName: r.specName }));
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
  // (cookies + localStorage) is brought in separately via `statePath:` and
  // loaded read-only with agent-browser's `--state` flag, so re-running the
  // spec — locally or in CI — never mutates the source-of-truth state file.
  const sessionName = generateLiveSessionName();
  log.meta("session", sessionName);

  let statePath: string | null = null;
  if (spec.statePath) {
    statePath = isAbsolute(spec.statePath) ? spec.statePath : resolve(cwd, spec.statePath);
    try {
      await access(statePath);
    } catch {
      const msg = `spec.statePath points to a missing file: ${statePath}`;
      log.error(msg);
      return { kind: "error", featureName, specName, error: msg };
    }
    log.meta("state", statePath);
  }

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
 * Classify each failed live run via `analyzeFailure` — same prompt as the
 * deterministic path (Issue #47), fed the live transcript instead of the
 * vitest log. Auth / diff failures degrade to `analysisSkipped`.
 */
async function runFailureAnalysisForLiveRuns(
  runs: SpecRunOutcome[],
  driftBySpec: Map<string, ReportSpecResult["driftIssues"]>,
  opts: RunLiveOptions,
  cwd: string,
): Promise<Map<string, LiveFailureAnalysis>> {
  const out = new Map<string, LiveFailureAnalysis>();
  const failed = runs.filter(
    (r): r is Extract<SpecRunOutcome, { kind: "run" }> =>
      r.kind === "run" && r.result.status === "failed",
  );
  if (failed.length === 0) return out;

  const auth = driftAuthAvailable();
  if (!auth.ok) {
    log.info(`failure analysis skipped (${auth.reason})`);
    for (const r of failed) {
      out.set(`${r.featureName}/${r.specName}`, {
        analysis: null,
        analysisSkipped: auth.reason,
        failureLogExcerpt: null,
        diffExcerpt: null,
      });
    }
    return out;
  }

  const baseRef = resolveBaseRef(opts.base);
  const diff: PrDiffResult = await capturePrDiff(baseRef, cwd);
  if (!diff.ok) {
    log.info(`failure analysis: source diff unavailable (${diff.error}) — analyzing without diff context`);
  }

  log.blank();
  for (const r of failed) {
    const key = `${r.featureName}/${r.specName}`;
    log.info(`failure analysis: ${key}`);
    const excerpt = await buildLiveTranscriptExcerpt(r.result);
    if (excerpt === null) {
      out.set(key, {
        analysis: null,
        analysisSkipped: "no failed step found in run result",
        failureLogExcerpt: null,
        diffExcerpt: null,
      });
      continue;
    }
    const outcome = await analyzeFailure(
      {
        liveTranscriptExcerpt: excerpt,
        specYaml: r.specYaml,
        diffPatch: diff.ok ? diff.diff.patch : null,
        changedFiles: diff.ok ? diff.diff.nameStatus : null,
        baseRef: diff.ok ? baseRef : null,
        driftIssues: driftBySpec.get(key) ?? null,
        ...(opts.language ? { outputLanguage: opts.language } : {}),
      },
      { ...(opts.model ? { model: opts.model } : {}), cwd },
    );
    const pct = Math.round(outcome.analysis.confidence * 100);
    const headline = outcome.analysis.headline.trim() || (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
    log.info(`  → ${outcome.analysis.label} (${pct}%) ${headline}`);
    out.set(key, {
      analysis: outcome.analysis,
      analysisSkipped: null,
      failureLogExcerpt: excerpt,
      diffExcerpt: diff.ok ? diff.diff.patch : null,
    });
  }
  return out;
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
