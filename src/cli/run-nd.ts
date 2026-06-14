import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as log from "./logger.ts";
import { addLanguageOption } from "./options.ts";
import { preflightAgentBrowserCommand } from "./preflight.ts";

import { analyzeDrift } from "../drift/analyze.ts";
import { collectIncludedBlockNames, expandSpec } from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  getSpecDir,
  listAllSpecsWithSpecFile,
  loadAllBlocks,
  loadAvailableBlocks,
  loadRunNdUserPrompt,
  readSpecFile,
  resolveSpecTargets,
} from "../store/index.ts";
import { buildRunId } from "../runtime/nd-artifacts.ts";
import { runNdExecutor, type NdRunResult, type NdStepResult } from "../runtime/nd-executor.ts";
import { generateRunNdSessionName } from "../prompts/run-nd.ts";
import { ndRunToReportResult } from "../report/nd-adapter.ts";
import { renderRunReport } from "../report/render.ts";
import type { ReportSpecResult, RunReportData } from "../report/schema.ts";

interface RunNdOptions {
  model?: string;
  language?: string;
  session?: string;
  out?: string;
  reportDir?: string;
  retry?: number;
  driftAudit?: boolean;
}

const RUN_ND_PROMPT_VERSION = "1";

export const runNdCommand = addLanguageOption(
  new Command("run-nd")
    .argument(
      "[target]",
      "Spec id '<feature>/<spec>', a feature name to run all its specs, or omitted to run every spec under .ccqa/features/.",
    )
    .description(
      "Run specs non-deterministically: Claude executes each step live with relaxed agent-browser constraints and judges pass/fail per step. PNG screenshots and a STEP_RESULT verdict are saved per step.",
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--session <name>",
      "Reuse an existing agent-browser session name. When running multiple specs each spec gets a fresh session derived from this value (or generated when unset).",
    )
    .option(
      "--out <dir>",
      "Override the per-spec artifact directory. Default: <specDir>/runs/<runId>. Ignored when running multiple specs.",
    )
    .option(
      "--report-dir <dir>",
      "Also write a self-contained HTML report (index.html + report.json) to this directory, combining every spec in this invocation.",
    )
    .option(
      "--retry <n>",
      "Retry each failed step up to N more times before recording failure. Default 0.",
      (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
          throw new Error(`--retry must be a non-negative integer, got "${raw}"`);
        }
        return n;
      },
      0,
    )
    .option(
      "--drift-audit",
      "After all specs run, audit each spec for spec↔code drift via the existing `analyzeDrift` pipeline and include the findings in the HTML report (when --report-dir is also set).",
    ),
).action(async (target: string | undefined, opts: RunNdOptions) => {
  await runNdEntry(target, opts);
});

async function runNdEntry(target: string | undefined, opts: RunNdOptions): Promise<void> {
  log.header("run-nd", target ?? "(all specs)");

  await preflightAgentBrowserCommand();

  const specs = await resolveSpecTargets(target, listAllSpecsWithSpecFile);
  if (specs.length === 0) {
    log.warn("no specs to run");
    return;
  }
  log.meta("specs", specs.length);

  const userPromptSuffix = await loadRunNdUserPrompt();
  if (userPromptSuffix !== null) log.meta("user-prompt", ".ccqa/prompts/run-nd.user.md");

  // The user can pin a session name only when running a single spec; otherwise
  // every spec gets its own fresh session so the previous spec's Chrome state
  // doesn't bleed into the next one.
  const sessionOverride = specs.length === 1 ? opts.session : undefined;

  const runs: SpecRunOutcome[] = [];
  for (let i = 0; i < specs.length; i++) {
    const { featureName, specName } = specs[i]!;
    const label = `${featureName}/${specName}`;
    if (specs.length > 1) {
      log.blank();
      log.info(`[${i + 1}/${specs.length}] ${label}`);
    }
    runs.push(await runOneSpec({ featureName, specName, opts, userPromptSuffix, sessionOverride }));
  }

  const failedCount = runs.filter(
    (r) => r.kind === "error" || (r.kind === "run" && r.result.status === "failed"),
  ).length;

  log.blank();
  log.meta(
    "summary",
    `${runs.length - failedCount} passed / ${failedCount} failed`,
  );

  const driftBySpec = opts.driftAudit
    ? await runDriftAudit(runs, opts)
    : new Map<string, ReportSpecResult["driftIssues"]>();

  if (opts.reportDir) {
    await writeReport(opts.reportDir, runs, driftBySpec);
  }

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

/**
 * Run the `analyzeDrift` pipeline against every successfully-run spec and
 * return a `featureName/specName → driftIssues` map. Drift findings are
 * always shown in the HTML report (when `--report-dir` is set) but do NOT
 * change the run-nd exit code — they are advisory, not pass/fail. Specs that
 * couldn't even be loaded (`kind: "error"`) are skipped because the audit
 * needs a parseable spec.yaml.
 */
async function runDriftAudit(
  runs: SpecRunOutcome[],
  opts: RunNdOptions,
): Promise<Map<string, ReportSpecResult["driftIssues"]>> {
  const targets = runs
    .filter((r): r is Extract<SpecRunOutcome, { kind: "run" }> => r.kind === "run")
    .map((r) => ({ featureName: r.featureName, specName: r.specName }));
  const out = new Map<string, ReportSpecResult["driftIssues"]>();
  if (targets.length === 0) return out;

  log.blank();
  log.info(`drift audit: ${targets.length} spec${targets.length > 1 ? "s" : ""}`);
  const blocks = await loadAvailableBlocks();
  const results = await analyzeDrift({
    targets,
    cwd: process.cwd(),
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
  sessionOverride: string | undefined;
}): Promise<SpecRunOutcome> {
  const { featureName, specName, opts, userPromptSuffix, sessionOverride } = args;
  const specDir = getSpecDir(featureName, specName);

  let specContent: string;
  try {
    specContent = await readSpecFile(featureName, specName);
  } catch (err) {
    log.error(`failed to read spec: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "error", featureName, specName, error: String(err) };
  }

  const spec = parseTestSpec(specContent);
  const blocks = await loadAllBlocks();
  const expanded = expandSpec(spec, { blocks });

  log.meta("spec", spec.title);
  log.meta("steps", expanded.length);
  const includes = collectIncludedBlockNames(spec);
  if (includes.length > 0) log.meta("blocks", includes.join(", "));

  const sessionName = sessionOverride ?? generateRunNdSessionName();
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

  return {
    kind: "run",
    featureName,
    specName,
    runDir,
    specYaml: specContent,
    result,
  };
}

async function writeReport(
  reportDir: string,
  runs: SpecRunOutcome[],
  driftBySpec: Map<string, ReportSpecResult["driftIssues"]>,
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  const results: ReportSpecResult[] = runs.flatMap((r) => {
    if (r.kind !== "run") return [];
    const key = `${r.featureName}/${r.specName}`;
    const base = ndRunToReportResult({
      featureName: r.featureName,
      specName: r.specName,
      specYaml: r.specYaml,
      result: r.result,
      reportDir,
    });
    return [{ ...base, driftIssues: driftBySpec.get(key) ?? null }];
  });
  const data: RunReportData = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runId: process.env["GITHUB_RUN_ID"] ?? null,
    git: { head: null, base: null },
    model: null,
    promptVersion: RUN_ND_PROMPT_VERSION,
    results,
  };
  const reportPath = join(reportDir, "index.html");
  const jsonPath = join(reportDir, "report.json");
  await writeFile(reportPath, renderRunReport(data), "utf-8");
  await writeFile(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  log.blank();
  log.meta("report", reportPath);
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

