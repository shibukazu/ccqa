import { Command } from "commander";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { posix as posixPath } from "node:path";
import type { Readable } from "node:stream";
import {
  getTestScript,
  listAllSpecs,
  listFeatureTree,
  listSpecsForFeature,
  loadAllBlocks,
  loadAvailableBlocks,
  resolveSpecTargets,
  tryReadSpecFile,
} from "../store/index.ts";
import { parseTestSpec } from "../spec/parser.ts";
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
import * as log from "./logger.ts";

// Passing --config to vitest prevents it from discovering the host's
// vitest.config.ts and inheriting setupFiles/environment/aliases that were
// never meant to apply to ccqa's browser-driving specs.
const USER_VITEST_CONFIG = resolve(".ccqa/vitest.config.ts");

const DEFAULT_REPORT_DIR = "ccqa-report";
const EVIDENCE_SUBDIR = "evidence";

async function resolveVitestConfig(): Promise<string> {
  try {
    await access(USER_VITEST_CONFIG);
    return USER_VITEST_CONFIG;
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

interface RunOptions {
  driftReport?: string | boolean;
  driftBase?: string;
  model?: string;
  language?: string;
  evidence?: boolean;
}

export const runCommand = addLanguageOption(
  new Command("run")
    .argument("[target]", "Spec to run: '<feature>/<spec>', '<feature>', or omit for all")
    .description(
      "Run generated agent-browser test scripts. " +
        "Pass --drift-report to also write a self-contained HTML run report: each failing spec " +
        "gets a drift audit plus a root-cause call (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG), and " +
        "the report lets a human grade the calls to measure their accuracy. " +
        "Requires ANTHROPIC_API_KEY or a local Claude login for the analysis part.",
    )
    .option(
      "--drift-report [dir]",
      `Write an HTML run report with drift analysis of failures (default dir: ${DEFAULT_REPORT_DIR}/)`,
    )
    .option(
      "--drift-base <ref>",
      "Base ref the source diff is taken against for failure analysis (default: GITHUB_BASE_REF, then origin/main)",
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Used by --drift-report only. Overrides CCQA_MODEL.",
    )
    .option(
      "--no-evidence",
      `Skip step-boundary evidence capture (PNG + meta JSON written to ${DEFAULT_REPORT_DIR}/${EVIDENCE_SUBDIR}/ by default)`,
    ),
).action(async (target: string | undefined, opts: RunOptions) => {
  await runTests(target, opts);
});

async function runTests(target: string | undefined, opts: RunOptions): Promise<void> {
  log.header("run", target);

  const specs = await resolveSpecTargets(target, listAllSpecs);

  if (specs.length === 0) {
    log.error("no test scripts found");
    log.hint("run 'ccqa generate <feature>/<spec>' first to generate tests");
    process.exit(1);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "ccqa-run-"));
  const summaries: SpecRunSummary[] = [];
  let overallExitCode = 0;
  const vitestConfig = await resolveVitestConfig();
  const captureOutput = Boolean(opts.driftReport);
  // Evidence lives under the report dir even without --drift-report, so the
  // PNGs/JSON work as a standalone CI artifact.
  const evidenceEnabled = opts.evidence !== false;
  const reportDir =
    typeof opts.driftReport === "string" ? opts.driftReport : DEFAULT_REPORT_DIR;
  const evidenceRoot = evidenceEnabled
    ? resolve(process.cwd(), reportDir, EVIDENCE_SUBDIR)
    : null;

  try {
    for (let i = 0; i < specs.length; i++) {
      const { featureName, specName } = specs[i]!;
      const scriptFile = await getTestScript(featureName, specName);
      if (!scriptFile) {
        log.warn(`${featureName}/${specName}: no test.spec.ts found`);
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
        evidenceDir
          ? { env: { ...process.env, CCQA_EVIDENCE_DIR: evidenceDir } }
          : {},
      );

      const tail = captureOutput ? new TailBuffer(OUTPUT_TAIL_CAP) : null;
      await Promise.all([
        streamFiltered(proc.stdout, process.stdout, tail),
        streamFiltered(proc.stderr, process.stderr, tail),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) overallExitCode = exitCode;

      const report = await readReport(reportFile);
      summaries.push({
        featureName,
        specName,
        scriptFile,
        report,
        exitCode,
        outputTail: tail ? tail.toString() : null,
        evidenceDir,
      });
      log.blank();
    }

    printSummary(summaries);
    await maybeWriteDriftReport(summaries, opts);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  process.exit(overallExitCode);
}

export function failedSpec(s: SpecRunSummary): boolean {
  if (s.exitCode !== 0) return true;
  return (s.report?.numFailedTests ?? 0) > 0;
}

/**
 * Opt-in post-vitest report hook. With `--drift-report`, a self-contained
 * HTML report is ALWAYS written (a green run is still a useful run summary);
 * failing specs additionally get a spec↔code drift audit and a three-way
 * root-cause call with the PR diff as context. The hook never changes the
 * exit code — the run's outcome is determined by vitest alone — and when
 * Claude auth is unavailable only the analysis is skipped, not the report.
 */
async function maybeWriteDriftReport(
  summaries: SpecRunSummary[],
  opts: RunOptions,
): Promise<void> {
  if (!opts.driftReport) return;
  const outDir = typeof opts.driftReport === "string" ? opts.driftReport : DEFAULT_REPORT_DIR;
  const cwd = process.cwd();

  const auth = driftAuthAvailable();
  const failed = summaries.filter(failedSpec);
  if (!auth.ok && failed.length > 0) {
    log.info(`failure analysis skipped (${auth.reason})`);
  }

  const baseRef = resolveBaseRef(opts.driftBase);
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

  // Drift audit first (existing analyzeDrift), so its findings can feed the
  // failure analysis prompt as supporting context.
  let driftResults: SpecResult[] = [];
  if (auth.ok && failed.length > 0) {
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
    // spec.yaml is read once here and shared with both the evidence captions
    // (via loadStepDescriptions) and the failure-analysis prompt (via specYaml).
    const specYaml = await tryReadSpecFile(s.featureName, s.specName, cwd);
    const stepDescriptions = parseStepDescriptions(specYaml, allBlocks);
    const evidence = await loadEvidenceForSpec(s, outDir, stepDescriptions);
    const base = {
      feature: s.featureName,
      spec: s.specName,
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
    if (!auth.ok) {
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

  const reportPath = join(outDir, "index.html");
  await mkdir(outDir, { recursive: true });
  await writeFile(reportPath, renderRunReport(data), "utf8");
  log.info(`run report written to ${reportPath}`);
}

/**
 * Read the JSON meta files written by abStepEvidence() and rewrite the PNG
 * paths so the report can link to them with a plain `<img src="evidence/...">`.
 * Posix path semantics on purpose: the report is rendered as HTML and URLs
 * always use `/`, regardless of the host OS.
 *
 * Missing/unreadable/malformed files are silently dropped — an evidence-capture
 * failure must not surface as a different failure mode in the report.
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
  const reportRoot = resolve(process.cwd(), reportDir);
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
  // The step description always comes from spec.yaml's `expected` — that text
  // identifies what the step was *supposed* to do. Failure detail lives in
  // `failureSummary` as its own field so the renderer can stack them.
  let description: string | null = null;
  if (typeof stepId === "string") {
    description = descriptionByStepId.get(stepId) ?? null;
  }
  // Standalone fallback failure capture (legacy scripts without
  // __setCurrentStep) lands as `failure` with no spec entry — surface the
  // summary as description so it isn't blank.
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
 * Parse the spec.yaml for a given spec, expand any included blocks, and
 * return `step id → expected` so the report can show what each evidence
 * screenshot is supposed to verify. Returns an empty map when the spec
 * can't be loaded — evidence still surfaces, just without descriptions.
 */
function parseStepDescriptions(
  yaml: string | null,
  blocks: Map<string, BlockSpec>,
): Map<string, string> {
  if (!yaml) return new Map();
  try {
    const spec = parseTestSpec(yaml);
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
 * Compose the failure log fed to the analysis prompt and embedded in the
 * report. With `--reporter=json` vitest writes (almost) nothing to
 * stdout/stderr — the assertion failures live in the JSON report — so the
 * structured failureMessages come first and the raw output tail (console
 * logs, agent-browser noise) is appended as secondary context.
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
 * Keeps the LAST `cap` characters appended. Vitest puts the failure summary
 * at the end of its output, so the tail is the part worth keeping when a
 * noisy spec overflows the cap.
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

