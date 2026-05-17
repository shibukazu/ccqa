import { Command } from "commander";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  parseSpecPath,
  getTestScript,
  listAllSpecs,
  listFeatureTree,
  listSpecsForFeature,
  loadAvailableBlocks,
} from "../store/index.ts";
import { bundledVitestConfigPath } from "../runtime/bundled-config.ts";
import { spawnVitestStreaming } from "../runtime/spawn-vitest.ts";
import { analyzeDrift } from "../drift/analyze.ts";
import { renderDrift } from "../drift/format.ts";
import { determineExitCode } from "../drift/exit-code.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import type { Format, SpecTarget } from "../drift/types.ts";
import * as log from "./logger.ts";

// Passing --config to vitest prevents it from discovering the host's
// vitest.config.ts and inheriting setupFiles/environment/aliases that were
// never meant to apply to ccqa's browser-driving specs.
const USER_VITEST_CONFIG = resolve(".ccqa/vitest.config.ts");

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

type SpecRunSummary = {
  featureName: string;
  specName: string;
  scriptFile: string;
  report: VitestJsonReport | null;
  exitCode: number;
};

interface RunOptions {
  drift?: boolean;
  driftStrict?: boolean;
  format?: string;
  model?: string;
}

export const runCommand = new Command("run")
  .argument("[target]", "Spec to run: '<feature>/<spec>', '<feature>', or omit for all")
  .description(
    "Run generated agent-browser test scripts. " +
      "Pass --drift to invoke a Claude-driven drift analysis on each failing spec " +
      "(skipped silently when no test fails). Requires ANTHROPIC_API_KEY or a local Claude login.",
  )
  .option("--drift", "On vitest failure, run drift analysis on the failing specs")
  .option(
    "--drift-strict",
    "Treat drift ERROR findings as a run failure (exit 1 even if vitest passed). Implies --drift.",
  )
  .option("--format <fmt>", "Output format for the drift block: text | json | github", "text")
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Used by --drift only. Overrides CCQA_MODEL.",
  )
  .action(async (target: string | undefined, opts: RunOptions) => {
    await runTests(target, opts);
  });

async function runTests(target: string | undefined, opts: RunOptions): Promise<void> {
  log.header("run", target);

  const specs = await resolveSpecs(target);

  if (specs.length === 0) {
    log.error("no test scripts found");
    log.hint("run 'ccqa generate <feature>/<spec>' first to generate tests");
    process.exit(1);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "ccqa-run-"));
  const summaries: SpecRunSummary[] = [];
  let overallExitCode = 0;
  const vitestConfig = await resolveVitestConfig();

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
      const proc = spawnVitestStreaming([
        "run",
        "--config",
        vitestConfig,
        scriptFile,
        "--reporter=json",
        `--outputFile.json=${reportFile}`,
      ]);

      await Promise.all([
        streamFiltered(proc.stdout, process.stdout),
        streamFiltered(proc.stderr, process.stderr),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) overallExitCode = exitCode;

      const report = await readReport(reportFile);
      summaries.push({ featureName, specName, scriptFile, report, exitCode });
      log.blank();
    }

    printSummary(summaries);
    overallExitCode = await maybeRunDrift(summaries, opts, overallExitCode);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  process.exit(overallExitCode);
}

function failedSpec(s: SpecRunSummary): boolean {
  if (s.exitCode !== 0) return true;
  return (s.report?.numFailedTests ?? 0) > 0;
}

function parseDriftFormat(raw: string | undefined): Format {
  const v = raw ?? "text";
  if (v === "text" || v === "json" || v === "github") return v;
  log.error(`invalid --format: ${v} (expected text|json|github)`);
  process.exit(2);
}

/**
 * Opt-in post-vitest drift hook. Only fires when --drift (or --drift-strict)
 * was passed AND at least one spec failed. Skips silently when auth is
 * unavailable so the run's exit code is determined by vitest alone.
 */
async function maybeRunDrift(
  summaries: SpecRunSummary[],
  opts: RunOptions,
  currentExitCode: number,
): Promise<number> {
  const driftEnabled = opts.drift === true || opts.driftStrict === true;
  if (!driftEnabled) return currentExitCode;

  const failing = summaries.filter(failedSpec);
  if (failing.length === 0) return currentExitCode;

  const auth = driftAuthAvailable();
  if (!auth.ok) {
    log.info(`drift analysis skipped (${auth.reason})`);
    return currentExitCode;
  }

  const format = parseDriftFormat(opts.format);
  const cwd = process.cwd();
  const tree = await listFeatureTree(cwd);
  const targets = failing
    .map((s): SpecTarget | null => {
      const feature = tree.find((f) => f.featureName === s.featureName);
      const spec = feature?.specs.find((sp) => sp.specName === s.specName);
      if (!spec) return null;
      const t: SpecTarget = { featureName: s.featureName, specName: s.specName };
      if (spec.relatedPaths) t.relatedPaths = spec.relatedPaths;
      if (spec.includedBlocks) t.includedBlocks = spec.includedBlocks;
      return t;
    })
    .filter((t): t is SpecTarget => t !== null);

  if (targets.length === 0) {
    log.info("drift analysis skipped (no spec.yaml found for failing specs)");
    return currentExitCode;
  }

  const blocks = await loadAvailableBlocks(cwd);
  const results = await analyzeDrift({
    targets,
    cwd,
    blocks,
    concurrency: Math.min(3, targets.length),
    ...(opts.model ? { model: opts.model } : {}),
    onSpecStart: (t) => {
      if (format === "text") log.info(`drift: checking ${t.featureName}/${t.specName}`);
    },
  });

  if (format === "text") {
    process.stdout.write(`\n${C.cyan}${C.bold}──────── drift analysis ────────${C.reset}\n`);
  }
  process.stdout.write(renderDrift(results, format, cwd));

  if (opts.driftStrict && determineExitCode(results, "error") !== 0) {
    return currentExitCode || 1;
  }
  return currentExitCode;
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
      }
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0 && !NOISE_LINE_PATTERNS.some((p) => p.test(buffer))) {
    sink.write(buffer);
  }
}

async function resolveSpecs(target?: string): Promise<Array<{ featureName: string; specName: string }>> {
  if (!target) {
    return listAllSpecs();
  }

  if (target.includes("/")) {
    const { featureName, specName } = parseSpecPath(target);
    return [{ featureName, specName }];
  }

  const specNames = await listSpecsForFeature(target);
  return specNames.map((specName) => ({ featureName: target, specName }));
}
