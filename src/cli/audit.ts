import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCcqaDir,
  listFeatureTree,
  loadAvailableBlocks,
  parseSpecPath,
} from "../store/index.ts";
import { analyzeDrift } from "../drift/analyze.ts";
import { renderDrift } from "../drift/format.ts";
import { determineExitCode } from "../drift/exit-code.ts";
import { driftResultsToReport } from "../drift/to-report.ts";
import type { Format, SpecResult, SpecTarget, Threshold } from "../drift/types.ts";
import { collectChangedSpecs } from "./changed-specs.ts";
import { packDirToTarGz } from "../hub/core/tar.ts";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import { addLanguageOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { hubHeaderOption, hubTokenOption, hubUrlOption, resolveHubClient } from "./hub-conn.ts";
import { detectBranch, getGitHead } from "./git-branch.ts";
import { withUsageErrors } from "./usage-errors.ts";
import * as log from "./logger.ts";
import { withCostTally } from "../claude/cost-tally.ts";
import { reportCost } from "./cost-line.ts";

interface AuditOptions {
  reportFormat?: Format;
  exitOn?: Threshold;
  concurrency?: string;
  model?: string;
  cwd?: string;
  onlyAffectedBy?: string;
  language?: string;
  reportToHub?: boolean;
  project?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
}

const DEFAULT_CONCURRENCY = 3;

export const auditCommand = addLanguageOption(
  new Command("audit")
    .argument(
      "[feature/spec]",
      "Optional spec id. If omitted, every spec under .ccqa/features/ is checked.",
    )
    .description(
      "Read each spec against the code it describes and report where the two have drifted. " +
        "Static: no browser is run, so this is the cheap check to put in front of `ccqa run`.",
    )
    .optionsGroup("Which specs to audit:")
    .option(
      "--only-affected-by <ref>",
      "Only specs `ccqa select-specs` judges reached by the diff against <ref> (e.g. origin/main). In pull_request CI, pass $GITHUB_BASE_REF. Costs one model call; specs it cannot decide are audited rather than skipped.",
    )
    .optionsGroup("How to run it:")
    .option("--concurrency <n>", `Parallel spec checks (default: ${DEFAULT_CONCURRENCY})`)
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .optionsGroup("What to do with the results:")
    .option("--report-format <fmt>", "Output format: text | json | github", "text")
    .option(
      "--report-to-hub",
      "Push the result to a ccqa hub as a run (kind: drift), which is what updates the drift ledger `ccqa run --only-audited-clean` reads.",
    )
    .option(
      "--exit-on <level>",
      "Exit non-zero on this severity or higher: warn | error",
      "error",
    )
    .optionsGroup("Environment and connection:")
    .option(
      "--cwd <path>",
      "Working directory used as both the .ccqa root and the codebase Claude reads. Useful for monorepos. Defaults to process.cwd().",
    )
    .option("--project <name>", "Logical project name for the pushed run. Defaults to the current directory's name.")
    .option(...hubUrlOption)
    .option(...hubTokenOption)
    .option(...hubHeaderOption),
).action(withUsageErrors(async (specPath: string | undefined, opts: AuditOptions) => {
  await withCostTally(() => runAudit(specPath, opts));
}));

async function runAudit(specPath: string | undefined, opts: AuditOptions): Promise<void> {
  const format = parseFormat(opts.reportFormat);
  const threshold = parseSeverity(opts.exitOn);
  const concurrency = parseConcurrency(opts.concurrency);
  const cwd = resolveCwd(opts.cwd);

  await ensureCcqaDir(cwd);

  if (opts.onlyAffectedBy && specPath) {
    log.error("--only-affected-by and an explicit spec id cannot be combined; it only applies to a full sweep");
    process.exit(2);
  }

  let targets = await collectTargets(specPath, cwd);
  if (targets.length === 0) {
    exitWithNoSpecs(format, "no test specs found under .ccqa/features/");
  }

  if (format === "text") {
    log.header("audit", specPath ?? `${targets.length} spec${targets.length > 1 ? "s" : ""}`);
    if (opts.cwd) log.meta("cwd", cwd);
  }

  let baseRef: string | null = null;

  if (opts.onlyAffectedBy) {
    const total = targets.length;
    const selection = await collectChangedSpecs(targets, {
      cwd,
      base: opts.onlyAffectedBy,
      quiet: format !== "text",
      ...(opts.model ? { model: opts.model } : {}),
    });
    // The base reported to the hub is the one selection actually diffed
    // against — resolving it a second time here could name another commit.
    targets = selection.specs;
    baseRef = selection.base.ref;
    if (format === "text") {
      log.meta("scoped", `${targets.length} of ${total} spec${total > 1 ? "s" : ""}`);
    }
    if (targets.length === 0) {
      exitWithNoSpecs(format, "no specs intersect the changed file set; nothing to check");
    }
  }

  const blocks = await loadAvailableBlocks(cwd);
  const results = await analyzeDrift({
    targets,
    cwd,
    blocks,
    concurrency,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    onSpecStart: (t) => {
      if (format === "text") log.info(`checking ${t.featureName}/${t.specName}`);
    },
  });

  process.stdout.write(renderDrift(results, format, cwd));

  if (opts.reportToHub) {
    await pushDriftResults({ results, threshold, cwd, opts, format, baseRef });
  }

  reportCost();
  process.exit(determineExitCode(results, threshold));
}

/**
 * Push a finished drift audit to a ccqa hub as a `kind: "drift"` run, so it
 * shows up alongside `ccqa run` runs in the hub UI. Best-effort: a missing
 * hub connection warns and returns rather than failing the command (`--report-to-hub`
 * never changes drift's own exit code).
 *
 * `resolveHub` is injectable so tests can supply a fake `HubClient` without
 * a real hub connection; it defaults to the real flag/env resolution.
 */
export async function pushDriftResults(
  args: {
    results: SpecResult[];
    threshold: Threshold;
    cwd: string;
    opts: AuditOptions;
    format: Format;
    baseRef?: string | null;
  },
  resolveHub: (opts: AuditOptions) => HubClient | null = resolveHubClient,
): Promise<void> {
  const { results, threshold, cwd, opts, format, baseRef } = args;
  const hub = resolveHub(opts);
  if (!hub) {
    log.warn("--report-to-hub requires a hub connection (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN) — skipping push");
    return;
  }

  try {
    const project = resolveProject({ project: opts.project, cwd });
    const [branch, head] = await Promise.all([detectBranch(cwd), getGitHead(cwd)]);

    const report = driftResultsToReport(results, {
      threshold,
      git: { head, base: baseRef ?? null },
    });

    const dir = await mkdtemp(join(tmpdir(), "ccqa-drift-push-"));
    try {
      await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
      const archive = await packDirToTarGz(dir);
      const run = await hub.pushRun(archive, {
        project,
        ...(branch ? { branch } : {}),
        kind: "drift",
      });
      if (format === "text") {
        // best-effort push なので、URL未設定時にexitするresolveBaseUrlではなくここで独立導出する
        const baseUrl = (opts.hubUrl ?? process.env.CCQA_HUB_URL ?? "").replace(/\/+$/, "");
        log.info(`pushed drift result to hub: ${baseUrl}/#/runs/${run.id}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    if (err instanceof HubApiError) {
      log.error(`hub request failed (${err.status} ${err.code}): ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

function exitWithNoSpecs(format: Format, message: string): never {
  reportCost();
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ specs: [] }, null, 2)}\n`);
  } else if (format === "text") {
    log.info(message);
  }
  process.exit(0);
}

async function collectTargets(specPath: string | undefined, cwd: string): Promise<SpecTarget[]> {
  const tree = await listFeatureTree(cwd);
  if (specPath) {
    const { featureName, specName } = parseSpecPath(specPath);
    const spec = tree.find((f) => f.featureName === featureName)?.specs.find((s) => s.specName === specName);
    if (!spec?.hasSpecFile) {
      log.error(`spec not found: ${featureName}/${specName} (under ${cwd})`);
      process.exit(1);
    }
    return [{ featureName, specName }];
  }

  const out: SpecTarget[] = [];
  for (const feature of tree) {
    for (const spec of feature.specs) {
      if (!spec.hasSpecFile) continue;
      out.push({ featureName: feature.featureName, specName: spec.specName });
    }
  }
  return out;
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
  log.error(`invalid --exit-on: ${v} (expected warn|error)`);
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

export type { SpecResult, SpecTarget } from "../drift/types.ts";
export { determineExitCode } from "../drift/exit-code.ts";
