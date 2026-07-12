import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCcqaDir,
  listFeatureTree,
  loadAvailableBlocks,
  parseBlockPath,
  parseSpecPath,
  specKey,
} from "../store/index.ts";
import { analyzeDrift } from "../drift/analyze.ts";
import { renderDrift } from "../drift/format.ts";
import { determineExitCode } from "../drift/exit-code.ts";
import { driftResultsToReport } from "../drift/to-report.ts";
import type { Format, SpecResult, SpecTarget, Threshold } from "../drift/types.ts";
import {
  getChangedFiles,
  isPathAffectedBy,
  resolveBaseRef,
  type ChangedFile,
} from "../drift/affected.ts";
import { routeNewFilesToSpecs } from "../drift/route-new-files.ts";
import { packDirToTarGz } from "../hub/core/tar.ts";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import { addLanguageOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";
import { hubHeaderOption, hubTokenOption, hubUrlOption, resolveHubClient } from "./hub-conn.ts";
import { detectBranch, getGitHead } from "./git-branch.ts";
import * as log from "./logger.ts";

interface DriftOptions {
  format?: Format;
  severity?: Threshold;
  concurrency?: string;
  model?: string;
  cwd?: string;
  changed?: boolean;
  base?: string;
  language?: string;
  push?: boolean;
  project?: string;
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
}

const DEFAULT_CONCURRENCY = 3;

export const driftCommand = addLanguageOption(
  new Command("drift")
    .argument(
      "[feature/spec]",
      "Optional spec id. If omitted, every spec under .ccqa/features/ is checked.",
    )
    .description(
      "Standalone spec ↔ codebase static audit. Use for PR checks where the browser isn't run. " +
        "For run-time audit with a structured report, see `ccqa run --report`.",
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
    .option(
      "--changed",
      "Restrict drift checks to specs whose relatedPaths intersect the git diff against --base (or, in CI, $GITHUB_BASE_REF, else origin/main). New files are routed to specs via a single lightweight Claude call.",
    )
    .option(
      "--base <ref>",
      "Base ref to diff against when --changed is set. Defaults to $GITHUB_BASE_REF (CI) or origin/main.",
    )
    .option("--push", "Push the drift result to a ccqa hub as a run (kind: drift).")
    .option("--project <name>", "Logical project name for the pushed run. Defaults to the current directory's name.")
    .option(...hubUrlOption)
    .option(...hubTokenOption)
    .option(...hubHeaderOption),
).action(async (specPath: string | undefined, opts: DriftOptions) => {
    const format = parseFormat(opts.format);
    const threshold = parseSeverity(opts.severity);
    const concurrency = parseConcurrency(opts.concurrency);
    const cwd = resolveCwd(opts.cwd);

    await ensureCcqaDir(cwd);

    if (opts.changed && specPath) {
      log.error("--changed and an explicit spec id cannot be combined; --changed only applies to a full sweep");
      process.exit(2);
    }

    let targets = await collectTargets(specPath, cwd);
    if (targets.length === 0) {
      exitWithNoSpecs(format, "no test specs found under .ccqa/features/");
    }

    if (format === "text") {
      log.header("drift", specPath ?? `${targets.length} spec${targets.length > 1 ? "s" : ""}`);
      if (opts.cwd) log.meta("cwd", cwd);
    }

    const baseRef = opts.changed ? resolveBaseRef(opts.base) : null;

    if (opts.changed) {
      const total = targets.length;
      targets = await filterByChanged({ targets, cwd, baseOverride: opts.base, format, model: opts.model });
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

    if (opts.push) {
      await pushDriftResults({ results, threshold, cwd, opts, format, baseRef });
    }

    process.exit(determineExitCode(results, threshold));
  });

/**
 * Push a finished drift audit to a ccqa hub as a `kind: "drift"` run, so it
 * shows up alongside `ccqa run` runs in the hub UI. Best-effort: a missing
 * hub connection warns and returns rather than failing the command (`--push`
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
    opts: DriftOptions;
    format: Format;
    baseRef?: string | null;
  },
  resolveHub: (opts: DriftOptions) => HubClient | null = resolveHubClient,
): Promise<void> {
  const { results, threshold, cwd, opts, format, baseRef } = args;
  const hub = resolveHub(opts);
  if (!hub) {
    log.warn("--push requires a hub connection (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN) — skipping push");
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
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ specs: [] }, null, 2)}\n`);
  } else if (format === "text") {
    log.info(message);
  }
  process.exit(0);
}

interface FilterByChangedInput {
  targets: SpecTarget[];
  cwd: string;
  baseOverride: string | undefined;
  format: Format;
  model: string | undefined;
}

async function filterByChanged(input: FilterByChangedInput): Promise<SpecTarget[]> {
  const { targets, cwd, baseOverride, format, model } = input;
  const base = resolveBaseRef(baseOverride);

  let changed: ChangedFile[];
  try {
    changed = await getChangedFiles(base, cwd);
  } catch (e) {
    log.error(`failed to run 'git diff' against ${base}: ${(e as Error).message}`);
    process.exit(2);
  }

  if (format === "text") {
    log.meta("changed-base", base);
    log.meta("changed-files", changed.length);
  }
  if (changed.length === 0) return [];

  // Outside-cwd changes participate in glob matching only (a spec opts in
  // with a repo-root-relative glob); the LLM new-file router and block
  // invalidation are scoped to this working directory.
  const newFiles = changed.filter((f) => f.status === "added" && !f.outsideCwd);
  const existingChanges = changed.filter((f) => f.status !== "added" || f.outsideCwd);

  const affected = new Set<string>();
  const touchedBlockNames = new Set<string>();
  for (const f of changed) {
    if (f.outsideCwd) continue;
    const blockName = parseBlockPath(f.path);
    if (blockName) touchedBlockNames.add(blockName);
  }

  for (const t of targets) {
    if (!t.relatedPaths) {
      affected.add(specKey(t));
      continue;
    }
    const hit = existingChanges.some((f) => isPathAffectedBy(f.path, t.relatedPaths!))
      || newFiles.some((f) => isPathAffectedBy(f.path, t.relatedPaths!));
    if (hit) {
      affected.add(specKey(t));
      continue;
    }
    if (t.includedBlocks?.some((name) => touchedBlockNames.has(name))) {
      affected.add(specKey(t));
    }
  }

  if (newFiles.length > 0) {
    if (format === "text") {
      log.info(`routing ${newFiles.length} new file(s) to specs via Claude...`);
    }
    const routed = await routeNewFilesToSpecs({
      newFiles: newFiles.map((f) => f.path),
      specs: targets
        .filter((t) => t.relatedPaths)
        .map((t) => ({
          featureName: t.featureName,
          specName: t.specName,
          relatedPaths: t.relatedPaths!,
        })),
      cwd,
      model,
    });
    for (const key of routed) affected.add(key);
  }

  return targets.filter((t) => affected.has(specKey(t)));
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
    return [{ featureName, specName, includedBlocks: spec.includedBlocks ?? [] }];
  }

  const out: SpecTarget[] = [];
  for (const feature of tree) {
    for (const spec of feature.specs) {
      if (!spec.hasSpecFile) continue;
      const t: SpecTarget = { featureName: feature.featureName, specName: spec.specName };
      if (spec.relatedPaths) t.relatedPaths = spec.relatedPaths;
      if (spec.includedBlocks) t.includedBlocks = spec.includedBlocks;
      out.push(t);
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

export type { SpecResult, SpecTarget } from "../drift/types.ts";
export { determineExitCode } from "../drift/exit-code.ts";
