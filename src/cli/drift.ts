import { relative, resolve } from "node:path";
import { Command } from "commander";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { buildDriftSystemPrompt, buildDriftUserPrompt } from "../prompts/drift.ts";
import {
  ensureCcqaDir,
  listFeatureTree,
  parseSpecPath,
  tryReadSpecFile,
} from "../store/index.ts";
import {
  DraftReportSchema,
  type DraftIssue,
  type DraftReport,
} from "../types.ts";
import { extractJsonBlock } from "./draft.ts";
import * as log from "./logger.ts";

type Format = "text" | "json" | "github";
type Threshold = "warn" | "error";

interface DriftOptions {
  format?: Format;
  severity?: Threshold;
  concurrency?: string;
  model?: string;
  cwd?: string;
}

interface SpecTarget {
  featureName: string;
  specName: string;
}

export interface SpecResult {
  target: SpecTarget;
  ok: boolean;
  issues: DraftIssue[];
  /** Filled when the LLM call itself failed (network, parse, etc.). */
  error?: string;
}

const DEFAULT_CONCURRENCY = 3;

export const driftCommand = new Command("drift")
  .argument(
    "[feature/spec]",
    "Optional spec id. If omitted, every spec under .ccqa/features/ is checked.",
  )
  .description(
    "Check whether each test-spec.md is still in sync with the current codebase (CI-friendly, no patches applied).",
  )
  .option("--format <fmt>", "Output format: text | json | github", "text")
  .option(
    "--severity <level>",
    "Exit non-zero on this severity or higher: warn | error",
    "error",
  )
  .option("--concurrency <n>", `Parallel spec checks (default: ${DEFAULT_CONCURRENCY})`)
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .option(
    "--cwd <path>",
    "Working directory used as both the .ccqa root and the codebase Claude reads. Useful for monorepos. Defaults to process.cwd().",
  )
  .action(async (specPath: string | undefined, opts: DriftOptions) => {
    const format = parseFormat(opts.format);
    const threshold = parseSeverity(opts.severity);
    const concurrency = parseConcurrency(opts.concurrency);
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();

    await ensureCcqaDir(cwd);

    const targets = await collectTargets(specPath, cwd);
    if (targets.length === 0) {
      if (format === "json") {
        process.stdout.write(`${JSON.stringify({ specs: [] }, null, 2)}\n`);
      } else {
        log.warn("no test specs found under .ccqa/features/");
      }
      process.exit(0);
    }

    if (format === "text") {
      log.header("drift", specPath ?? `${targets.length} spec${targets.length > 1 ? "s" : ""}`);
      if (opts.cwd) log.meta("cwd", cwd);
    }

    const results = await runChecks(targets, concurrency, opts.model, cwd, format);
    emitReport(results, format, cwd);

    process.exit(determineExitCode(results, threshold));
  });

async function collectTargets(specPath: string | undefined, cwd: string): Promise<SpecTarget[]> {
  if (specPath) {
    const { featureName, specName } = parseSpecPath(specPath);
    const content = await tryReadSpecFile(featureName, specName, cwd);
    if (content === null) {
      log.error(`spec not found: ${featureName}/${specName} (under ${cwd})`);
      process.exit(1);
    }
    return [{ featureName, specName }];
  }

  const tree = await listFeatureTree(cwd);
  const out: SpecTarget[] = [];
  for (const feature of tree) {
    for (const spec of feature.specs) {
      if (spec.hasSpecFile) {
        out.push({ featureName: feature.featureName, specName: spec.specName });
      }
    }
  }
  return out;
}

async function runChecks(
  targets: SpecTarget[],
  concurrency: number,
  model: string | undefined,
  cwd: string,
  format: Format,
): Promise<SpecResult[]> {
  const results: SpecResult[] = new Array(targets.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx]!;
      results[idx] = await checkSpec(target, model, cwd, format);
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

async function checkSpec(
  target: SpecTarget,
  model: string | undefined,
  cwd: string,
  format: Format,
): Promise<SpecResult> {
  const { featureName, specName } = target;
  const existing = await tryReadSpecFile(featureName, specName, cwd);
  if (existing === null) {
    return {
      target,
      ok: false,
      issues: [],
      error: `spec file disappeared after enumeration: ${featureName}/${specName}`,
    };
  }

  if (format === "text") {
    log.info(`checking ${featureName}/${specName}`);
  }

  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: buildDriftUserPrompt(existing),
      systemPrompt: buildDriftSystemPrompt(),
      allowedTools: ["Read", "Grep", "Glob"],
      silenceBashLog: true,
      cwd,
      ...(model ? { model } : {}),
    },
    (_msg: SDKMessage) => {},
  );

  if (isError) {
    return { target, ok: false, issues: [], error: "Claude returned an error result" };
  }

  const json = extractJsonBlock(result);
  if (!json) {
    return { target, ok: false, issues: [], error: "Claude did not return a json block" };
  }

  let report: DraftReport;
  try {
    report = DraftReportSchema.parse(JSON.parse(json));
  } catch (e) {
    return {
      target,
      ok: false,
      issues: [],
      error: `failed to parse drift report: ${(e as Error).message}`,
    };
  }

  return { target, ok: true, issues: report.issues };
}

function emitReport(results: SpecResult[], format: Format, cwd: string): void {
  if (format === "json") {
    emitJson(results);
    return;
  }
  if (format === "github") {
    emitGithub(results, cwd);
    return;
  }
  emitText(results);
}

const CATEGORY_LABEL: Record<DraftIssue["category"], string> = {
  assertable: "Assertability",
  setups: "Setup references",
  granularity: "Step granularity",
  unimplemented: "Unimplemented checks",
};

const HEAVY_RULE = "═".repeat(72);

function emitText(results: SpecResult[]): void {
  for (const r of results) {
    log.blank();
    const heading = `══ ${r.target.featureName}/${r.target.specName} `;
    const tail = "═".repeat(Math.max(3, 72 - heading.length));
    process.stdout.write(`${heading}${tail}\n`);

    if (r.error) {
      process.stdout.write(`  ERROR  ${r.error}\n`);
      continue;
    }

    const errors = r.issues.filter((i) => i.severity === "ERROR");
    const warnings = r.issues.filter((i) => i.severity === "WARN");
    const passed = r.issues.filter((i) => i.severity === "OK");

    if (errors.length === 0 && warnings.length === 0) {
      const label = passed.length === 1 ? "check" : "checks";
      const detail = passed.length > 0
        ? `all ${passed.length} ${label} passed`
        : "no issues";
      process.stdout.write(`  ✓  ${detail}\n`);
      continue;
    }

    for (const issue of errors) writeFinding("ERROR", issue);
    for (const issue of warnings) writeFinding("WARN", issue);

    if (passed.length > 0) {
      const names = passed.map((i) => CATEGORY_LABEL[i.category]).join(", ");
      process.stdout.write(`\n  ✓  passed (${passed.length}): ${names}\n`);
    }
  }

  log.blank();
  process.stdout.write(`${HEAVY_RULE}\n`);
  const totals = summarize(results);
  log.meta("specs", `${results.length} (${totals.errored} errored)`);
  log.meta(
    "findings",
    `${totals.error} error, ${totals.warn} warn, ${totals.ok} ok`,
  );
}

function writeFinding(level: "ERROR" | "WARN", issue: DraftIssue): void {
  const stepPart = issue.stepId ? ` ${issue.stepId}` : "";
  process.stdout.write(`\n  ${level}  ${CATEGORY_LABEL[issue.category]}${stepPart}\n`);
  process.stdout.write(`    ${issue.message}\n`);
  if (issue.detail) {
    process.stdout.write(`    └ ${issue.detail.replace(/\n/g, "\n      ")}\n`);
  }
}

function emitJson(results: SpecResult[]): void {
  const payload = {
    specs: results.map((r) => ({
      feature: r.target.featureName,
      spec: r.target.specName,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
      issues: r.issues.map((i) => ({
        severity: i.severity,
        category: i.category,
        stepId: i.stepId,
        message: i.message,
        ...(i.detail ? { detail: i.detail } : {}),
      })),
    })),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitGithub(results: SpecResult[], cwd: string): void {
  const repoRoot = process.env["GITHUB_WORKSPACE"] ?? process.cwd();
  for (const r of results) {
    const file = githubRelPath(cwd, repoRoot, r.target.featureName, r.target.specName);
    if (r.error) {
      process.stdout.write(`::error file=${file}::${escapeGhMessage(r.error)}\n`);
      continue;
    }
    for (const issue of r.issues) {
      if (issue.severity === "OK") continue;
      const level = issue.severity === "ERROR" ? "error" : "warning";
      const title = `${r.target.featureName}/${r.target.specName} — ${issue.category}${issue.stepId ? ` (${issue.stepId})` : ""}`;
      const body = issue.detail ? `${issue.message}\n${issue.detail}` : issue.message;
      process.stdout.write(
        `::${level} file=${file},title=${escapeGhProp(title)}::${escapeGhMessage(body)}\n`,
      );
    }
  }
}

function githubRelPath(cwd: string, repoRoot: string, featureName: string, specName: string): string {
  const abs = resolve(cwd, ".ccqa", "features", featureName, "test-cases", specName, "test-spec.md");
  const rel = relative(repoRoot, abs);
  return rel.startsWith("..") ? abs : rel;
}

function escapeGhMessage(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeGhProp(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/,/g, "%2C").replace(/:/g, "%3A");
}

function summarize(results: SpecResult[]): {
  error: number;
  warn: number;
  ok: number;
  errored: number;
} {
  let error = 0;
  let warn = 0;
  let ok = 0;
  let errored = 0;
  for (const r of results) {
    if (r.error) errored++;
    for (const issue of r.issues) {
      if (issue.severity === "ERROR") error++;
      else if (issue.severity === "WARN") warn++;
      else ok++;
    }
  }
  return { error, warn, ok, errored };
}

export function determineExitCode(results: SpecResult[], threshold: Threshold): number {
  for (const r of results) {
    if (r.error) return 1;
    for (const issue of r.issues) {
      if (issue.severity === "ERROR") return 1;
      if (threshold === "warn" && issue.severity === "WARN") return 1;
    }
  }
  return 0;
}

function parseFormat(raw: string | undefined): Format {
  const v = raw ?? "text";
  if (v === "text" || v === "json" || v === "github") return v;
  log.error(`invalid --format: ${v} (expected text|json|github)`);
  process.exit(2);
}

function parseSeverity(raw: string | undefined): Threshold {
  const v = raw ?? "error";
  if (v === "warn" || v === "error") return v;
  log.error(`invalid --severity: ${v} (expected warn|error)`);
  process.exit(2);
}

function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    log.error(`invalid --concurrency: ${raw} (expected positive integer)`);
    process.exit(2);
  }
  return n;
}
