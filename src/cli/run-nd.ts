import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as log from "./logger.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";

import { analyzeDrift } from "../drift/analyze.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import { resolveBaseRef } from "../drift/affected.ts";
import { capturePrDiff, type PrDiffResult } from "../report/diff.ts";
import { analyzeFailure } from "../report/analyze.ts";
import { buildNdTranscriptExcerpt } from "../report/nd-transcript-excerpt.ts";
import { collectIncludedBlockNames, expandSpec } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  getSpecDir,
  loadAllBlocks,
  loadAvailableBlocks,
  loadRunNdUserPrompt,
  readSpecFile,
} from "../store/index.ts";
import { buildRunId } from "../runtime/nd-artifacts.ts";
import { formatNdBatchCost, formatNdCost } from "../runtime/nd-cost-format.ts";
import { runNdExecutor, type NdRunResult, type NdStepResult } from "../runtime/nd-executor.ts";
import { generateRunNdSessionName } from "../prompts/run-nd.ts";
import { ndRunToReportResult } from "../report/nd-adapter.ts";
import type { ReportSpecResult } from "../report/schema.ts";

export interface RunNdOptions {
  model?: string;
  language?: string;
  out?: string;
  reportDir?: string;
  retry?: number;
  driftAudit?: boolean;
  failureAnalysis?: boolean;
  base?: string;
  cwd?: string;
}

export type LiveSpecRun = {
  /** ReportSpecResult rows the dispatcher can merge into the unified HTML. */
  reportResults: ReportSpecResult[];
  /** Failed (or unloadable) specs; the dispatcher uses this to set the exit code. */
  failedCount: number;
};

/**
 * Run pre-filtered `mode: live` specs through `runNdExecutor` (Claude +
 * agent-browser) and, when `reportDir` is set, run drift audit + failure
 * analysis to produce report rows. Sibling of `runDeterministicSpecs`.
 */
export async function runLiveSpecs(
  specs: readonly { featureName: string; specName: string }[],
  opts: RunNdOptions,
): Promise<LiveSpecRun> {
  if (specs.length === 0) return { reportResults: [], failedCount: 0 };

  const cwd = opts.cwd ?? process.cwd();
  await preflightAgentBrowserCommand();

  log.meta("live-specs", specs.length);

  const userPromptSuffix = await loadRunNdUserPrompt(cwd);
  if (userPromptSuffix !== null) log.meta("user-prompt", ".ccqa/prompts/run-nd.user.md");

  // Fresh agent-browser session per spec so Chrome state doesn't bleed across.
  const runs: SpecRunOutcome[] = [];
  for (let i = 0; i < specs.length; i++) {
    const { featureName, specName } = specs[i]!;
    const label = `${featureName}/${specName}`;
    if (specs.length > 1) {
      log.blank();
      log.info(`[${i + 1}/${specs.length}] ${label}`);
    }
    runs.push(await runOneSpec({ featureName, specName, opts, userPromptSuffix, cwd }));
  }

  const failedCount = runs.filter(
    (r) => r.kind === "error" || (r.kind === "run" && r.result.status === "failed"),
  ).length;

  log.blank();
  log.meta(
    "live-summary",
    `${runs.length - failedCount} passed / ${failedCount} failed`,
  );
  logBatchCost(runs);

  const driftBySpec = opts.reportDir && opts.driftAudit
    ? await runDriftAudit(runs, opts, cwd)
    : new Map<string, ReportSpecResult["driftIssues"]>();

  const failureAnalysisEnabled = opts.reportDir != null && opts.failureAnalysis !== false;
  const analysisBySpec = failureAnalysisEnabled
    ? await runFailureAnalysisForLiveRuns(runs, driftBySpec, opts, cwd)
    : new Map<string, LiveFailureAnalysis>();

  const reportDir = opts.reportDir ?? ".";
  return {
    failedCount,
    reportResults: buildLiveReportResults(runs, driftBySpec, analysisBySpec, reportDir),
  };
}

function buildLiveReportResults(
  runs: SpecRunOutcome[],
  driftBySpec: Map<string, ReportSpecResult["driftIssues"]>,
  analysisBySpec: Map<string, LiveFailureAnalysis>,
  reportDir: string,
): ReportSpecResult[] {
  return runs.flatMap((r) => {
    if (r.kind !== "run") return [];
    const key = `${r.featureName}/${r.specName}`;
    const base = ndRunToReportResult({
      featureName: r.featureName,
      specName: r.specName,
      specYaml: r.specYaml,
      result: r.result,
      reportDir,
    });
    const a = analysisBySpec.get(key);
    return [{
      ...base,
      driftIssues: driftBySpec.get(key) ?? null,
      ...(a
        ? {
            analysis: a.analysis,
            analysisSkipped: a.analysisSkipped,
            failureLogExcerpt: a.failureLogExcerpt,
            diffExcerpt: a.diffExcerpt,
          }
        : {}),
    }];
  });
}

/**
 * Run `analyzeDrift` against every successfully-loaded spec and return a
 * `featureName/specName → driftIssues` map. Drift findings are advisory —
 * they show in the HTML report but do not change the run-nd exit code.
 */
async function runDriftAudit(
  runs: SpecRunOutcome[],
  opts: RunNdOptions,
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
      result: NdRunResult;
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
  opts: RunNdOptions;
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

  const sessionName = generateRunNdSessionName();
  log.meta("session", sessionName);

  const runId = buildRunId();
  const runDir = opts.out ?? join(specDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  log.meta("runDir", runDir);

  const result = await runNdExecutor({
    spec: { title: spec.title },
    steps: expanded,
    runId,
    runDir,
    sessionName,
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
  const costLine = formatNdCost(result.cost, { compact: false });
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
  const line = formatNdBatchCost(costs);
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
  opts: RunNdOptions,
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
    const excerpt = await buildNdTranscriptExcerpt(r.result);
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
        ndTranscriptExcerpt: excerpt,
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

function count(steps: NdStepResult[], target: NdStepResult["status"]): number {
  return steps.filter((s) => s.status === target).length;
}

function renderRunMarkdown(featureName: string, specName: string, result: NdRunResult): string {
  const head = [
    `# run-nd: ${featureName}/${specName}`,
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

