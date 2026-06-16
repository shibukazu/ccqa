import { Command } from "commander";
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
import { ANALYSIS_PROMPT_VERSION } from "../report/prompt.ts";
import { renderRunReport } from "../report/render.ts";
import { ReportEvidenceSchema, type ReportEvidence, type ReportSpecResult, type RunReportData } from "../report/schema.ts";
import { addLanguageOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveSpecsModes } from "./spec-mode.ts";
import { runLiveSpecs, type RunNdOptions } from "./run-nd.ts";
import { collectChangedSpecs } from "./changed-specs.ts";
import * as log from "./logger.ts";

const REPORT_FORMATS = ["text", "json", "github"] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];

const DEFAULT_REPORT_DIR = "ccqa-report";
const EVIDENCE_SUBDIR = "evidence";

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
  model?: string;
  language?: string;
  format?: ReportFormat;
  failureAnalysis?: boolean;
  driftAudit?: boolean;
  evidence?: boolean;
  retry?: number;
  out?: string;
  changed?: boolean;
}

export const runCommand = addLanguageOption(
  new Command("run")
    .argument("[target]", "Spec to run: '<feature>/<spec>', '<feature>', or omit for all")
    .description(
      "Run specs. Each spec's execution mode comes from its spec.yaml `mode:` field " +
        "(default deterministic; set `mode: live` to have Claude drive agent-browser live per step). " +
        "Deterministic specs replay the recorded test.spec.ts under vitest. " +
        "Pass --report to write one unified HTML report covering both modes.",
    )
    .option(
      "--report [dir]",
      `Write a self-contained HTML run report (failure analysis + drift audit by default). Default dir: ${DEFAULT_REPORT_DIR}/`,
    )
    .option(
      "--changed",
      "Restrict execution to specs whose relatedPaths intersect the git diff against --base (or, in CI, $GITHUB_BASE_REF, else origin/main). Cannot be combined with an explicit spec id.",
    )
    .option(
      "--no-failure-analysis",
      "Skip the per-failure root-cause classification (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG). --report only.",
    )
    .option(
      "--no-drift-audit",
      "Skip the spec↔code drift audit shown in the report. --report only.",
    )
    .option(
      "--base <ref>",
      "Base ref the source diff is taken against for failure analysis (default: GITHUB_BASE_REF, then origin/main).",
    )
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
    )
    .option(
      "--format <fmt>",
      "Additional output format alongside HTML when --report is set: 'text' (default), 'json' (writes report.json), 'github' (GitHub Actions annotations on stdout).",
      (raw): ReportFormat => {
        if ((REPORT_FORMATS as readonly string[]).includes(raw)) return raw as ReportFormat;
        throw new Error(`--format must be one of ${REPORT_FORMATS.join(" | ")}`);
      },
      "text" as ReportFormat,
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--no-evidence",
      `(deterministic only) Skip step-boundary evidence capture (PNG + meta JSON written to ${DEFAULT_REPORT_DIR}/${EVIDENCE_SUBDIR}/ by default).`,
    )
    .option(
      "--retry <n>",
      "(live only) Retry each failed step up to N more times before recording failure. Default 0.",
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
      "--out <dir>",
      "(live only) Override the per-spec artifact directory. Default: <specDir>/runs/<runId>. Ignored when running multiple specs.",
    ),
).action(async (target: string | undefined, opts: RunOptions) => {
  await runDispatcher(target, opts);
});

function resolveReportDir(
  report: string | boolean | undefined,
  cwd: string,
): string | undefined {
  if (report === undefined || report === false) return undefined;
  const raw = typeof report === "string" ? report : DEFAULT_REPORT_DIR;
  return resolve(cwd, raw);
}

async function runDispatcher(target: string | undefined, opts: RunOptions): Promise<void> {
  log.header("run", target ?? (opts.changed ? "(changed)" : "(all specs)"));

  if (opts.changed && target) {
    log.error("--changed and an explicit spec target cannot be combined");
    process.exit(2);
  }

  const cwd = resolveCwd(opts.cwd);
  let specs = await resolveSpecTargets(target, () => listAllSpecsWithSpecFile(cwd), cwd);

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
    return;
  }

  // Det specs run first under vitest, then live ones via Claude; results
  // merge into a single HTML report.
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

  const ndOpts: RunNdOptions = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.out ? { out: opts.out } : {}),
    cwd,
    ...(opts.base ? { base: opts.base } : {}),
    ...(reportDir ? { reportDir } : {}),
    ...(typeof opts.retry === "number" ? { retry: opts.retry } : {}),
    ...(reportDir && opts.driftAudit !== false ? { driftAudit: true } : {}),
    ...(reportDir && opts.failureAnalysis === false ? { failureAnalysis: false } : {}),
  };
  const live = await runLiveSpecs(liveSpecs, ndOpts);

  let overallExitCode = det.exitCode;
  if (live.failedCount > 0 && overallExitCode === 0) overallExitCode = 1;

  if (reportDir) {
    const detReport = await analyzeDeterministicSummaries(
      det.summaries,
      opts,
      cwd,
      reportDirForEvidence,
    );
    await writeUnifiedReport({
      reportDir,
      results: [...detReport.results, ...live.reportResults],
      diff: detReport.diff,
      baseRef: detReport.baseRef,
      opts,
    });
  }

  process.exit(overallExitCode);
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
  const summaries: SpecRunSummary[] = [];
  let exitCode = 0;
  const vitestConfig = await resolveVitestConfig(cwd);
  const captureOutput = Boolean(opts.report);
  // Evidence lives under the report dir even when --report is absent so the
  // PNGs work as a standalone CI artifact.
  const evidenceRoot = opts.evidence !== false ? join(reportDirAbs, EVIDENCE_SUBDIR) : null;

  try {
    for (let i = 0; i < specs.length; i++) {
      const { featureName, specName } = specs[i]!;
      const scriptFile = await getTestScript(featureName, specName, cwd);
      if (!scriptFile) {
        log.warn(`${featureName}/${specName}: no test.spec.ts found`);
        log.hint("run 'ccqa record <feature>/<spec>' to record it, or set 'mode: live' in spec.yaml");
        continue;
      }

      log.run(`${featureName}/${specName}`);
      log.meta("test", scriptFile);
      log.blank();

      const reportFile = join(tmpDir, `report-${i}.json`);
      const evidenceDir = evidenceRoot ? join(evidenceRoot, featureName, specName) : null;
      if (evidenceDir) {
        await rm(evidenceDir, { recursive: true, force: true });
        await mkdir(evidenceDir, { recursive: true });
      }
      const proc = spawnVitestStreaming(
        [
          "run",
          "--config",
          vitestConfig,
          scriptFile,
          "--reporter=json",
          `--outputFile.json=${reportFile}`,
        ],
        {
          cwd,
          env: evidenceDir
            ? { ...process.env, CCQA_EVIDENCE_DIR: evidenceDir }
            : process.env,
        },
      );

      const tail = captureOutput ? new TailBuffer(OUTPUT_TAIL_CAP) : null;
      await Promise.all([
        streamFiltered(proc.stdout, process.stdout, tail),
        streamFiltered(proc.stderr, process.stderr, tail),
      ]);
      const specExitCode = await proc.exited;
      if (specExitCode !== 0) exitCode = specExitCode;

      const report = await readReport(reportFile);
      summaries.push({
        featureName,
        specName,
        scriptFile,
        report,
        exitCode: specExitCode,
        outputTail: tail ? tail.toString() : null,
        evidenceDir,
      });
      log.blank();
    }

    printSummary(summaries);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  return { summaries, exitCode };
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
): Promise<{ results: ReportSpecResult[]; diff: PrDiffResult; baseRef: string }> {
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
        ndRun: null,
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
        },
        { ...(opts.model ? { model: opts.model } : {}), cwd },
      );
      analysis = outcome.analysis;

      if (!printedHeader) {
        process.stdout.write(
          `\n${C.cyan}${C.bold}──────── failure analysis ────────${C.reset}\n`,
        );
        printedHeader = true;
      }
      const pct = Math.round(outcome.analysis.confidence * 100);
      const oneLine =
        outcome.analysis.headline.trim() ||
        (outcome.analysis.reasoning.split("\n")[0] ?? "").trim();
      process.stdout.write(
        `${C.red}✖${C.reset} ${C.bold}${s.featureName}/${s.specName}${C.reset} → ` +
          `${C.bold}${outcome.analysis.label}${C.reset} (${pct}%)` +
          `${oneLine ? ` ${C.dim}${oneLine}${C.reset}` : ""}\n`,
      );
      const recommendation = outcome.analysis.recommendation.trim();
      if (recommendation) {
        process.stdout.write(`  ${C.dim}→ ${recommendation}${C.reset}\n`);
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
      ndRun: null,
    });
  }

  return { results, diff, baseRef };
}

/** Write the unified HTML / JSON / GitHub-annotation report for one run. */
async function writeUnifiedReport(args: {
  reportDir: string;
  results: ReportSpecResult[];
  diff: PrDiffResult;
  baseRef: string | null;
  opts: RunOptions;
}): Promise<void> {
  const { reportDir, results, diff, baseRef, opts } = args;
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
    results,
  };

  const reportPath = join(reportDir, "index.html");
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, renderRunReport(data), "utf8");
  log.info(`run report written to ${reportPath}`);

  // Commander supplies "text" as the default when --format is omitted, so the
  // value is always set here.
  const format = opts.format;
  if (format === "json") {
    const jsonPath = join(reportDir, "report.json");
    await writeFile(jsonPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    log.info(`run report (json) written to ${jsonPath}`);
  } else if (format === "github") {
    for (const r of results) {
      if (r.status !== "failed") continue;
      const source = r.analysis?.headline || r.analysis?.reasoning || "test failed";
      const headline = source.split("\n")[0]?.trim() || "test failed";
      process.stdout.write(
        `::error title=${r.feature}/${r.spec}::${headline.replace(/[\r\n]+/g, " ")}\n`,
      );
    }
  }
}

/**
 * Read abStepEvidence() meta files and rewrite PNG paths to posix relpaths
 * the HTML report can link to. Missing/malformed files are silently dropped
 * so an evidence-capture failure doesn't surface as a different failure mode.
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

function toPosix(p: string): string {
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
  process.stdout.write(
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
      process.stdout.write(`${icon} ${header} ${C.dim}(no report)${C.reset}\n`);
      continue;
    }

    totalTests += s.report.numTotalTests;
    totalPassed += s.report.numPassedTests;
    totalFailed += s.report.numFailedTests;
    totalSkipped += s.report.numPendingTests;

    const ok = s.report.success;
    const icon = ok ? `${C.green}✔${C.reset}` : `${C.red}✖${C.reset}`;
    const countColor = ok ? C.green : C.red;
    process.stdout.write(
      `${icon} ${header}  ${countColor}${s.report.numPassedTests}/${s.report.numTotalTests}${C.reset} ${C.dim}passed${C.reset}\n`,
    );

    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        const aIcon = assertionIcon(a.status);
        const dur = a.duration != null ? ` ${C.gray}${formatDuration(a.duration)}${C.reset}` : "";
        process.stdout.write(`    ${aIcon} ${a.fullName}${dur}\n`);
        if (a.status === "failed" && a.failureMessages?.length) {
          for (const msg of a.failureMessages) {
            const firstLine = msg.split("\n")[0] ?? msg;
            process.stdout.write(`        ${C.red}${firstLine}${C.reset}\n`);
          }
        }
      }
    }
  }

  const specsPassed = summaries.filter((s) => s.exitCode === 0).length;
  const specsFailed = summaries.filter((s) => s.exitCode !== 0).length;
  process.stdout.write("\n");
  process.stdout.write(
    `  ${C.bold}Specs${C.reset}   ${summaries.length}  ` +
      `(${C.green}${specsPassed} passed${C.reset}, ${specsFailed > 0 ? C.red : C.dim}${specsFailed} failed${C.reset})\n`,
  );
  process.stdout.write(
    `  ${C.bold}Tests${C.reset}   ${totalTests}  ` +
      `(${C.green}${totalPassed} passed${C.reset}, ${totalFailed > 0 ? C.red : C.dim}${totalFailed} failed${C.reset}, ${C.yellow}${totalSkipped} skipped${C.reset})\n`,
  );
  process.stdout.write("\n");
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
  sink: NodeJS.WritableStream,
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

