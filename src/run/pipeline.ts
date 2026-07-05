import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { posix as posixPath } from "node:path";
import type { Readable } from "node:stream";
import {
  getTestScript,
  listAllSpecsWithSpecFile,
  listFeatureTree,
  loadAllBlocks,
  loadAvailableBlocks,
  resolveSpecTargets,
  tryReadSpecFile,
} from "../store/index.ts";
import { tryParseTestSpec } from "../spec/parser.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import { expandSpec } from "../spec/expand.ts";
import { FAILURE_STEP_ID } from "../runtime/evidence-constants.ts";
import type { BlockSpec } from "../types.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestStreaming } from "../runtime/spawn-vitest.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { runPool } from "../runtime/pool.ts";
import { analyzeDrift } from "../drift/analyze.ts";
import { resolveBaseRef } from "../drift/affected.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import type { SpecResult, SpecTarget } from "../drift/types.ts";
import { analyzeFailure } from "../report/analyze.ts";
import {
  capturePrDiff,
  scopePatchForSpec,
  splitPatchByFile,
  type PrDiffResult,
} from "../report/diff.ts";
import { emitGithubAnnotations } from "../report/github-format.ts";
import { ANALYSIS_PROMPT_VERSION } from "../report/prompt.ts";
import { fetchCustomPrompt } from "../prompts/custom-prompt.ts";
import type { AnalysisCustomPrompt } from "../prompts/custom-prompt.ts";
import { ReportEvidenceSchema, type ReportEvidence, type ReportSpecResult, type RunReportData } from "../report/schema.ts";
import { resolveProfileEnv } from "../cli/options.ts";
import { resolveHubContext, HubConnectionError, type HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import { resolveProjectOrThrow, ProjectNameError } from "../cli/resolve-project.ts";
import { resolveSpecsModes } from "../cli/spec-mode.ts";
import { runLiveSpecs, type RunLiveOptions } from "../cli/run-live.ts";
import { updateAgentPrompt } from "../cli/update-agent-prompt.ts";
import { collectChangedSpecs } from "../cli/changed-specs.ts";
import * as log from "../cli/logger.ts";
import { RunUsageError } from "./errors.ts";

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
  base?: string;
  cwd?: string;
  profile?: string;
  model?: string;
  language?: string;
  format?: ReportFormat;
  failureAnalysis?: boolean;
  driftAudit?: boolean;
  evidence?: boolean;
  retry?: number;
  out?: string;
  changed?: boolean;
  updateAgentPrompt?: boolean;
  concurrency?: number;
  hubUrl?: string;
  hubToken?: string;
  project?: string;
}

export interface RunPipelineResult {
  /** 0 when every spec passed, 1 when at least one spec failed. Usage errors throw `RunUsageError` instead. */
  exitCode: 0 | 1;
  /** Set only when `--report` was requested. */
  report: RunReportData | null;
  /** Absolute path `--report` was resolved to, when requested. */
  reportDir: string | null;
}

function resolveReportDir(
  report: string | boolean | undefined,
  cwd: string,
): string | undefined {
  if (report === undefined || report === false) return undefined;
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

  // Resolve the hub context for the analysis custom prompt (best-effort: an
  // unresolvable project or missing hub connection just means no custom
  // prompt, never a run-stopping error — unlike the profile resolution
  // above, which does throw RunUsageError). resolveHubContext re-resolves
  // the project internally rather than reusing projectForProfile — this
  // mirrors the pre-refactor code, which already resolved the project twice
  // (once for the profile, once here).
  let hubCtx: HubContext | null = null;
  try {
    hubCtx = resolveHubContext({ hubUrl: opts.hubUrl, hubToken: opts.hubToken, project: opts.project, cwd });
  } catch {
    hubCtx = null;
  }
  const customPrompt: AnalysisCustomPrompt | null = await fetchCustomPrompt(hubCtx);

  // No targets means "all specs"; resolveSpecTargets(undefined) enumerates them.
  // Multiple targets may overlap (e.g. a feature plus one of its specs), so dedupe.
  const enumerateAll = () => listAllSpecsWithSpecFile(cwd);
  const resolved = await Promise.all(
    (targets.length ? targets : [undefined]).map((t) => resolveSpecTargets(t, enumerateAll, cwd)),
  );
  let specs = dedupeSpecs(resolved.flat());

  if (opts.changed) {
    const before = specs.length;
    specs = await collectChangedSpecs(specs, { cwd, base: opts.base });
    log.meta(
      "changed-scoped",
      `${specs.length} of ${before} spec${before === 1 ? "" : "s"}`,
    );
  }

  if (specs.length === 0) {
    log.warn("no specs to run");
    return { exitCode: 0, report: null, reportDir: null };
  }

  // Det specs run first under vitest, then live ones via Claude; results
  // merge into a single report.json.
  const withMode = await resolveSpecsModes(specs, cwd);
  const detSpecs = withMode.filter((s) => s.mode === "deterministic");
  const liveSpecs = withMode.filter((s) => s.mode === "live");
  log.meta(
    "modes",
    `${detSpecs.length} deterministic / ${liveSpecs.length} live`,
  );

  // Warn when a mode-scoped flag is set but no spec of that mode will run,
  // rather than silently ignoring it.
  if (liveSpecs.length === 0) {
    if (typeof opts.retry === "number" && opts.retry > 0) log.warn("--retry is ignored without any 'mode: live' spec");
    if (opts.out) log.warn("--out is ignored without any 'mode: live' spec");
    if (opts.updateAgentPrompt) log.warn("--update-agent-prompt is ignored without any 'mode: live' spec");
  } else if (opts.out && liveSpecs.length > 1) {
    // A single --out dir can't hold multiple specs' artifacts without them
    // overwriting each other (worse under --concurrency), so it only applies
    // to single-spec runs, matching the flag's help text.
    log.warn("--out is ignored when running multiple live specs");
  }
  if (detSpecs.length === 0 && opts.evidence === false) {
    log.warn("--no-evidence is ignored without any 'mode: deterministic' spec");
  }
  log.blank();

  // Resolve report dir against `cwd` (not process.cwd()) so HTML, JSON, and
  // evidence PNGs share a directory even when --cwd points at a subpackage.
  const reportDir = resolveReportDir(opts.report, cwd);
  const reportDirForEvidence = reportDir ?? resolve(cwd, DEFAULT_REPORT_DIR);

  const det = await runDeterministicSpecs(detSpecs, opts, cwd, reportDirForEvidence);

  const liveOpts: RunLiveOptions = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.out && liveSpecs.length === 1 ? { out: opts.out } : {}),
    cwd,
    ...(opts.base ? { base: opts.base } : {}),
    ...(reportDir ? { reportDir } : {}),
    ...(typeof opts.retry === "number" ? { retry: opts.retry } : {}),
    concurrency: opts.concurrency ?? 1,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(reportDir && opts.driftAudit !== false ? { driftAudit: true } : {}),
    ...(reportDir && opts.failureAnalysis === false ? { failureAnalysis: false } : {}),
    hubContext: hubCtx,
    customPrompt,
  };
  const live = await runLiveSpecs(liveSpecs, liveOpts);

  let overallExitCode: 0 | 1 = det.exitCode !== 0 ? 1 : 0;
  if (live.failedCount > 0 && overallExitCode === 0) overallExitCode = 1;

  let report: RunReportData | null = null;
  if (reportDir) {
    const detReport = await analyzeDeterministicSummaries(
      det.summaries,
      opts,
      cwd,
      reportDirForEvidence,
      customPrompt,
    );
    report = await writeUnifiedReport({
      reportDir,
      results: [...detReport.results, ...live.reportResults],
      diff: detReport.diff,
      baseRef: detReport.baseRef,
      customPromptVersion: detReport.customPromptVersion,
      opts,
    });
  }

  // "ignored without any 'mode: live' spec" already warned upfront alongside
  // the other live-only flags.
  if (opts.updateAgentPrompt && liveSpecs.length > 0) {
    log.blank();
    await updateAgentPrompt({
      mode: "live",
      runSummary: buildLiveRunSummary(live.reportResults),
      hubContext: hubCtx,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.language ? { language: opts.language } : {}),
    });
  }

  return { exitCode: overallExitCode, report, reportDir: reportDir ?? null };
}

/**
 * Compact, prompt-friendly summary of one ccqa run for the live agent-prompt
 * update step. One section per spec: header line + per-step verdicts.
 * Kept to a few KB even with many specs/steps so the prompt cache can absorb
 * the bulk.
 */
function buildLiveRunSummary(results: readonly ReportSpecResult[]): string {
  const sections: string[] = [];
  for (const r of results) {
    if (!r.liveRun) continue;
    const head = `## ${r.feature}/${r.spec} — ${r.status}`;
    const steps = r.liveRun.steps
      .map((s) => `- [${s.status}] ${s.stepId}: ${oneLineSummary(s.reasoning)}`)
      .join("\n");
    sections.push(`${head}\n${steps}`);
  }
  return sections.length === 0 ? "(no live runs executed)" : sections.join("\n\n");
}

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
  const captureOutput = Boolean(opts.report);
  // Evidence lives under the report dir even when --report is absent so the
  // PNGs work as a standalone CI artifact.
  const evidenceRoot = opts.evidence !== false ? join(reportDirAbs, EVIDENCE_SUBDIR) : null;
  // Parallel vitest streams interleave illegibly, so above 1 worker each spec
  // buffers its narration + vitest output (via log.withBuffer) and flushes one
  // labelled block on completion. At 1 worker output streams live, as before.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const ctx: DeterministicSpecContext = { cwd, tmpDir, vitestConfig, captureOutput, evidenceRoot };

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
  evidenceRoot: string | null;
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
  const evidenceDir = ctx.evidenceRoot ? join(ctx.evidenceRoot, featureName, specName) : null;
  if (evidenceDir) {
    await rm(evidenceDir, { recursive: true, force: true });
    await mkdir(evidenceDir, { recursive: true });
  }
  const specEnv: NodeJS.ProcessEnv = { ...process.env, CCQA_RUN_ID: runId };
  if (evidenceDir) specEnv.CCQA_EVIDENCE_DIR = evidenceDir;
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
 * Build ReportSpecResult[] for a set of vitest summaries. Runs drift audit +
 * failure analysis when `--report` is on; degrades (no throw) when Claude
 * auth or git diff aren't available. Caller writes the HTML / JSON.
 */
async function analyzeDeterministicSummaries(
  summaries: readonly SpecRunSummary[],
  opts: RunOptions,
  cwd: string,
  reportDir: string,
  customPrompt: AnalysisCustomPrompt | null,
): Promise<{ results: ReportSpecResult[]; diff: PrDiffResult; baseRef: string; customPromptVersion: string | null }> {
  // Both pieces of automated analysis cost Claude turns. Disabling the
  // root-cause classification (--no-failure-analysis) implicitly disables
  // the drift audit too, since the audit is rendered as supporting
  // evidence under the classification — keeping the audit on without the
  // classification would burn cost without a place to display the result.
  // --no-drift-audit remains an independent opt-out for when the user
  // wants the classification but not the audit.
  const failureAnalysisEnabled = opts.failureAnalysis !== false;
  const driftAuditEnabled = failureAnalysisEnabled && opts.driftAudit !== false;

  const auth = failureAnalysisEnabled || driftAuditEnabled ? driftAuthAvailable() : { ok: false as const, reason: "skipped by flags" };
  const failed = summaries.filter(failedSpec);
  if (failureAnalysisEnabled && !auth.ok && failed.length > 0) {
    log.info(`failure analysis skipped (${auth.reason})`);
  }

  const baseRef = resolveBaseRef(opts.base);
  let diff: PrDiffResult = { ok: false, error: "diff not captured (no failures)" };
  if (failed.length > 0) {
    diff = await capturePrDiff(baseRef, cwd);
    if (!diff.ok) {
      log.info(`drift-report: source diff unavailable (${diff.error}) — analyzing without diff context`);
    }
  }

  // The feature tree only feeds relatedPaths/includedBlocks lookups for
  // failed specs — skip the directory walk entirely on a green run.
  const tree = failed.length > 0 ? await listFeatureTree(cwd) : [];
  const specInfoByKey = new Map(
    tree.flatMap((f) => f.specs.map((sp) => [`${f.featureName}/${sp.specName}`, sp] as const)),
  );
  const findSpecInfo = (s: SpecRunSummary) =>
    specInfoByKey.get(`${s.featureName}/${s.specName}`) ?? null;

  // Drift audit runs first so its findings can feed the failure-analysis prompt.
  let driftResults: SpecResult[] = [];
  if (driftAuditEnabled && auth.ok && failed.length > 0) {
    const targets = failed
      .map((s): SpecTarget | null => {
        const spec = findSpecInfo(s);
        if (!spec) return null;
        const t: SpecTarget = { featureName: s.featureName, specName: s.specName };
        if (spec.relatedPaths) t.relatedPaths = spec.relatedPaths;
        if (spec.includedBlocks) t.includedBlocks = spec.includedBlocks;
        return t;
      })
      .filter((t): t is SpecTarget => t !== null);

    if (targets.length > 0) {
      const blocks = await loadAvailableBlocks(cwd);
      driftResults = await analyzeDrift({
        targets,
        cwd,
        blocks,
        concurrency: Math.min(3, targets.length),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        onSpecStart: (t) => log.info(`drift audit: ${t.featureName}/${t.specName}`),
      });
    }
  }

  const patchSections =
    diff.ok && diff.diff.patch.length > 0 ? splitPatchByFile(diff.diff.patch) : null;

  // Load blocks once (shared across all specs) so evidence captions can show
  // the step's `expected` text from spec.yaml, including block-inlined steps.
  const allBlocks = await loadAllBlocks(cwd);

  let printedHeader = false;
  const results: ReportSpecResult[] = [];
  for (const s of summaries) {
    const assertions = collectAssertions(s);
    // Read spec.yaml once and reuse for both evidence captions and the
    // failure-analysis prompt.
    const specYaml = await tryReadSpecFile(s.featureName, s.specName, cwd);
    const parsedSpec = tryParseTestSpec(specYaml);
    const stepDescriptions = buildStepDescriptions(parsedSpec, allBlocks);
    const evidence = await loadEvidenceForSpec(s, reportDir, stepDescriptions);
    const base = {
      feature: s.featureName,
      spec: s.specName,
      title: parsedSpec?.title ?? null,
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

    const relatedPaths = findSpecInfo(s)?.relatedPaths ?? null;
    const diffExcerpt = patchSections ? scopePatchForSpec(patchSections, relatedPaths) : null;
    const driftResult = driftResults.find(
      (r) => r.target.featureName === s.featureName && r.target.specName === s.specName,
    );
    const driftIssues = driftResult?.ok ? driftResult.issues : null;
    const failureLog = buildFailureLog(s);

    let analysis: ReportSpecResult["analysis"] = null;
    let analysisSkipped: string | null = null;
    if (!failureAnalysisEnabled) {
      analysisSkipped = "skipped by --no-failure-analysis";
    } else if (!auth.ok) {
      analysisSkipped = auth.reason;
    } else if (specYaml === null) {
      analysisSkipped = "no spec.yaml found for this spec";
    } else {
      const script = await readScriptSafe(s.scriptFile);
      log.info(`failure analysis: ${s.featureName}/${s.specName}`);
      const outcome = await analyzeFailure(
        {
          script,
          specYaml,
          failureLog,
          diffPatch: diffExcerpt,
          changedFiles: diff.ok ? diff.diff.nameStatus : null,
          baseRef: diff.ok ? baseRef : null,
          driftIssues,
          ...(opts.language ? { outputLanguage: opts.language } : {}),
          ...(customPrompt ? { customPrompt } : {}),
        },
        { ...(opts.model ? { model: opts.model } : {}), cwd },
      );
      analysis = outcome.analysis;

      if (!printedHeader) {
        log.emitRaw(
          `\n${C.cyan}${C.bold}──────── failure analysis ────────${C.reset}\n`,
        );
        printedHeader = true;
      }
      const pct = Math.round(outcome.analysis.confidence * 100);
      const oneLine =
        outcome.analysis.headline.trim() ||
        (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
      log.emitRaw(
        `${C.red}✖${C.reset} ${C.bold}${s.featureName}/${s.specName}${C.reset} → ` +
          `${C.bold}${outcome.analysis.label}${C.reset} (${pct}%)` +
          `${oneLine ? ` ${C.dim}${oneLine}${C.reset}` : ""}\n`,
      );
      const recommendation = outcome.analysis.recommendation.trim();
      if (recommendation) {
        log.emitRaw(`  ${C.dim}→ ${recommendation}${C.reset}\n`);
      }
    }

    results.push({
      ...base,
      status: "failed",
      analysis,
      analysisSkipped,
      driftIssues,
      failureLogExcerpt: failureLog.length > 0 ? failureLog : null,
      diffExcerpt,
      specYaml,
      liveRun: null,
    });
  }

  return { results, diff, baseRef, customPromptVersion: customPrompt?.customPromptVersion ?? null };
}

/** Write the unified JSON (+ optional GitHub-annotation) report for one run. Returns the report data. */
async function writeUnifiedReport(args: {
  reportDir: string;
  results: ReportSpecResult[];
  diff: PrDiffResult;
  baseRef: string | null;
  customPromptVersion: string | null;
  opts: RunOptions;
}): Promise<RunReportData> {
  const { reportDir, results, diff, baseRef, customPromptVersion, opts } = args;
  const data: RunReportData = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    runId: process.env["GITHUB_RUN_ID"] ?? null,
    git: {
      head: diff.ok ? diff.diff.head : null,
      base: diff.ok ? baseRef : null,
    },
    model: opts.model ?? null,
    language: opts.language ?? null,
    promptVersion: ANALYSIS_PROMPT_VERSION,
    customPromptVersion,
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

/**
 * Read abStepEvidence() meta files and rewrite PNG paths to posix relpaths
 * (relative to the report dir) that report.json references and the hub UI
 * resolves. Missing/malformed files are silently dropped so an evidence-capture
 * failure doesn't surface as a different failure mode.
 */
async function loadEvidenceForSpec(
  s: SpecRunSummary,
  reportDir: string,
  descriptionByStepId: Map<string, string>,
): Promise<ReportEvidence[] | null> {
  const evidenceDir = s.evidenceDir;
  if (!evidenceDir) return null;
  let entries: string[];
  try {
    entries = await readdir(evidenceDir);
  } catch {
    return null;
  }
  const reportRoot = resolve(reportDir);
  const jsonFiles = entries.filter((n) => n.endsWith(".json"));
  const metas = (
    await Promise.all(
      jsonFiles.map((name) =>
        readEvidenceMeta(join(evidenceDir, name), evidenceDir, reportRoot, descriptionByStepId),
      ),
    )
  ).filter((m): m is ReportEvidence => m !== null);
  metas.sort((a, b) => {
    // Failure capture sinks to the end so per-step screenshots stay chronological.
    if (a.stepId === FAILURE_STEP_ID) return 1;
    if (b.stepId === FAILURE_STEP_ID) return -1;
    return a.stepId.localeCompare(b.stepId);
  });
  return metas.length > 0 ? metas : null;
}

async function readEvidenceMeta(
  metaPath: string,
  evidenceDir: string,
  reportRoot: string,
  descriptionByStepId: Map<string, string>,
): Promise<ReportEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const pngFile = (parsed as { pngFile?: unknown }).pngFile;
  if (typeof pngFile !== "string") return null;
  const absPng = join(evidenceDir, pngFile);
  const pngPath = posixPath.relative(toPosix(reportRoot), toPosix(absPng));
  const stepId = (parsed as { stepId?: unknown }).stepId;
  const failureSummary = (parsed as { failureSummary?: unknown }).failureSummary;
  const hasFailure = typeof failureSummary === "string" && failureSummary.length > 0;
  // Description comes from spec.yaml's `expected`; failure detail lives in
  // `failureSummary` as its own field so the renderer can stack them.
  let description: string | null = null;
  if (typeof stepId === "string") {
    description = descriptionByStepId.get(stepId) ?? null;
  }
  // Fallback failure capture (legacy scripts without __setCurrentStep) has no
  // spec entry — surface failureSummary as description so it isn't blank.
  if (!description && hasFailure) description = failureSummary as string;
  const candidate = {
    ...(parsed as Record<string, unknown>),
    pngPath,
    description,
    status: hasFailure ? "failed" : "passed",
    failureSummary: hasFailure ? failureSummary : null,
  };
  const result = ReportEvidenceSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Build `step id → expected` so the report can caption each evidence
 * screenshot. Returns empty map on expansion failure (evidence still surfaces).
 */
function buildStepDescriptions(
  spec: TestSpec | null,
  blocks: Map<string, BlockSpec>,
): Map<string, string> {
  if (!spec) return new Map();
  try {
    const expanded = expandSpec(spec, { blocks });
    return new Map(expanded.map((s) => [s.id, s.expected.trim()]));
  } catch {
    return new Map();
  }
}

export function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
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

/** Cap on the per-spec output tail kept for the report / analysis prompt. */
const OUTPUT_TAIL_CAP = 64 * 1024;

/**
 * Keeps the LAST `cap` characters appended — vitest puts the failure summary
 * at the end of its output, so the tail is what's worth keeping on overflow.
 */
export class TailBuffer {
  private buf = "";
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  append(s: string): void {
    this.buf += s;
    // Trim lazily at 2x so each append isn't a slice.
    if (this.buf.length > this.cap * 2) this.buf = this.buf.slice(-this.cap);
  }

  toString(): string {
    if (this.buf.length <= this.cap) return this.buf;
    return `[...output truncated...]\n${this.buf.slice(-this.cap)}`;
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

const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
const C = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  red: useColor ? "\x1b[31m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  gray: useColor ? "\x1b[90m" : "",
};

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
