import { Command } from "commander";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSpecPath,
  getTestScript,
  listAllSpecs,
  listSpecsForFeature,
} from "../store/index.ts";
import * as log from "./logger.ts";

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

export const runCommand = new Command("run")
  .argument("[target]", "Spec to run: '<feature>/<spec>', '<feature>', or omit for all")
  .description("Run generated agent-browser test scripts")
  .action(async (target?: string) => {
    await runTests(target);
  });

async function runTests(target?: string): Promise<void> {
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

  try {
    for (let i = 0; i < specs.length; i++) {
      const { featureName, specName } = specs[i]!;
      const scriptFile = await getTestScript(featureName, specName);
      if (!scriptFile) {
        log.warn(`${featureName}/${specName}: no test.spec.ts found`);
        continue;
      }

      log.info(`▶ ${featureName}/${specName}`);
      log.meta("test", scriptFile);
      log.blank();

      const reportFile = join(tmpDir, `report-${i}.json`);
      const proc = Bun.spawn(
        [
          "bunx",
          "vitest",
          "run",
          scriptFile,
          "--reporter=default",
          "--reporter=json",
          `--outputFile.json=${reportFile}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

      await Promise.all([
        streamFiltered(proc.stdout, Bun.stdout),
        streamFiltered(proc.stderr, Bun.stderr),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) overallExitCode = exitCode;

      const report = await readReport(reportFile);
      summaries.push({ featureName, specName, scriptFile, report, exitCode });
      log.blank();
    }

    printSummary(summaries);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  process.exit(overallExitCode);
}

async function readReport(path: string): Promise<VitestJsonReport | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as VitestJsonReport;
  } catch {
    return null;
  }
}

function printSummary(summaries: SpecRunSummary[]): void {
  process.stdout.write("\n────── ccqa summary ──────\n\n");

  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const s of summaries) {
    const header = `${s.featureName}/${s.specName}`;
    if (!s.report) {
      const icon = s.exitCode === 0 ? "✓" : "✗";
      process.stdout.write(`${icon} ${header} (no report)\n`);
      continue;
    }

    totalTests += s.report.numTotalTests;
    totalPassed += s.report.numPassedTests;
    totalFailed += s.report.numFailedTests;
    totalSkipped += s.report.numPendingTests;

    const icon = s.report.success ? "✓" : "✗";
    process.stdout.write(
      `${icon} ${header}  (${s.report.numPassedTests}/${s.report.numTotalTests} passed)\n`,
    );

    for (const file of s.report.testResults) {
      for (const a of file.assertionResults) {
        const aIcon = assertionIcon(a.status);
        const dur = a.duration != null ? `  ${formatDuration(a.duration)}` : "";
        process.stdout.write(`    ${aIcon} ${a.fullName}${dur}\n`);
        if (a.status === "failed" && a.failureMessages?.length) {
          for (const msg of a.failureMessages) {
            const firstLine = msg.split("\n")[0] ?? msg;
            process.stdout.write(`        ${firstLine}\n`);
          }
        }
      }
    }
  }

  process.stdout.write("\n");
  process.stdout.write(
    `  Specs      ${summaries.length} (${summaries.filter((s) => s.exitCode === 0).length} passed, ${summaries.filter((s) => s.exitCode !== 0).length} failed)\n`,
  );
  process.stdout.write(
    `  Tests      ${totalTests} (${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped)\n`,
  );
  process.stdout.write("\n");
}

function assertionIcon(status: VitestAssertionResult["status"]): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
    case "pending":
    case "todo":
      return "⊘";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

const NOISE_LINE_PATTERNS = [/^JSON report written to /];

async function streamFiltered(
  source: ReadableStream<Uint8Array>,
  sink: { write: (chunk: Uint8Array) => unknown },
): Promise<void> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const reader = source.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!NOISE_LINE_PATTERNS.some((p) => p.test(line))) {
          sink.write(encoder.encode(line + "\n"));
        }
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0 && !NOISE_LINE_PATTERNS.some((p) => p.test(buffer))) {
      sink.write(encoder.encode(buffer));
    }
  } finally {
    reader.releaseLock();
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
