import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { execFileP, getChangedFilesBetween, type ChangedFile } from "../drift/affected.ts";
import { errMessage } from "../run/errors.ts";
import { DEFAULT_REPORT_DIR } from "../run/report-constants.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadCoverageEdges, loadCoverageEdgesFromReport } from "../select/coverage-edges.ts";
import { loadSpecInventory, type SpecDescription } from "../select/inventory.ts";
import { specsToRun, type SelectReport, type SelectVerdict } from "../select/types.ts";
import {
  hubHeaderOption,
  hubTokenOption,
  hubUrlOption,
  resolveHubClient,
  type HubConnOptions,
  type HubContext,
} from "./hub-conn.ts";
import * as log from "./logger.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";

interface SelectSpecsOptions extends HubConnOptions {
  against?: string;
  base?: string;
  head?: string;
  repo?: string;
  cwd?: string;
  project?: string;
  format?: string;
  reportDir?: string;
}

const DEFAULT_HEAD = "HEAD";

export const selectSpecsCommand = new Command("select-specs")
  .description(
    "Decide which specs a range of commits reaches. Intersects the diff with each spec's last " +
      "measured reach — from the hub (`ccqa run --coverage --report-to-hub`) when one is configured, " +
      "else from a local `ccqa run --coverage` report directory — and returns one verdict per spec: " +
      "needed | notNeeded | unknown. A spec with no measurement is unknown, which runs.",
  )
  .option("--against <range>", "Git range as <base>..<head> (two-dot). Alternative to --base/--head together.")
  .option(
    "--base <ref>",
    "Commit the range starts at — typically what is currently deployed, or the previous commit on the branch. Alternative to --against.",
  )
  .option("--head <ref>", `Commit the range ends at, used with --base (default: ${DEFAULT_HEAD}). Not used with --against.`)
  .option(
    "--repo <path>",
    "Git repository the range is read from, when it is not the .ccqa root. Defaults to --cwd.",
  )
  .option(
    "--cwd <path>",
    "Working directory used as the .ccqa root. Changes outside it are reported but never attributed to a spec. Defaults to process.cwd().",
  )
  .option(
    "--project <name>",
    "Project whose coverage measurements are read from the hub. Defaults to the current directory's name.",
  )
  .option(...hubUrlOption)
  .option(...hubTokenOption)
  .option(...hubHeaderOption)
  .option(
    "--report-dir <dir>",
    `Local report directory read as the coverage ledger when no hub is configured (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN absent). Default: ${DEFAULT_REPORT_DIR}/.`,
  )
  .option("--format <fmt>", "Output format: text | json | paths", "text")
  .action(runSelectSpecs);

async function runSelectSpecs(opts: SelectSpecsOptions): Promise<void> {
  const format = parseFormat(opts.format);
  const cwd = resolveCwd(opts.cwd);
  const { base, head } = resolveRange(opts);
  const repo = await resolveRepo(opts.repo, cwd);
  const reportDirAbs = resolve(cwd, opts.reportDir ?? DEFAULT_REPORT_DIR);

  const hub = resolveHubClient(opts);
  const hubCtx: HubContext | null = hub
    ? { hub, project: resolveProject({ project: opts.project, cwd: opts.cwd }) }
    : null;

  // Independent inputs — the spec tree (fs), the diff (a git subprocess) and
  // the coverage edges (hub, or a local report when no hub is configured) —
  // read concurrently rather than in sequence.
  const [specsResult, changedResult, edgesReadout] = await Promise.all([
    loadSpecInventory(cwd).then(
      (specs) => ({ ok: true as const, specs }),
      (e: unknown) => ({ ok: false as const, error: e as Error }),
    ),
    // Renames stay delete + add: the diff is intersected with reach measured
    // before the rename, and only the old path can match an edge.
    getChangedFilesBetween(base, head, repo, { detectRenames: false }).then(
      (changed) => ({ ok: true as const, changed }),
      (e: unknown) => ({ ok: false as const, error: e as Error }),
    ),
    hubCtx ? loadCoverageEdges(hubCtx) : loadCoverageEdgesFromReport(reportDirAbs),
  ]);

  if (!specsResult.ok) {
    // A spec that will not parse cannot be judged, and clearing it unread is
    // the one outcome this command must not produce — so this is fatal.
    log.error(specsResult.error.message);
    process.exit(1);
  }
  const specs: SpecDescription[] = specsResult.specs;
  if (specs.length === 0) {
    log.error("no test specs found under .ccqa/features/");
    process.exit(1);
  }

  if (!changedResult.ok) {
    log.error(`failed to run 'git diff ${base}..${head}' in ${repo}: ${changedResult.error.message}`);
    process.exit(2);
  }
  const changed: ChangedFile[] = changedResult.changed;

  if (format === "text") {
    log.header("select-specs", `${base} → ${head}`);
    log.meta("ledger", hubCtx ? "hub" : reportDirAbs);
    if (opts.cwd) log.meta("cwd", cwd);
    if (opts.repo) log.meta("repo", repo);
    if (hubCtx) log.meta("project", hubCtx.project);
    log.meta("changed-files", changed.length);
    log.meta("specs", specs.length);
    log.meta("measured-specs", edgesReadout.edges.size);
  }

  const report = await selectSpecs({ changed, specs, cwd, repo, base, head, edges: edgesReadout });

  process.stdout.write(renderOutput(format, report));
  process.exit(0);
}

function renderOutput(format: "text" | "json" | "paths", report: SelectReport): string {
  if (format === "paths") return renderPaths(report);
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  return renderText(report);
}

/**
 * `--against` and `--base`/`--head` are the same input in two spellings — a
 * script composing a range already has both refs apart, a human typing one
 * wants the familiar `a..b`. Exactly one spelling is accepted: mixing them
 * (`--against` with `--head`) would leave one half silently unused.
 */
function resolveRange(opts: SelectSpecsOptions): { base: string; head: string } {
  const { against, base, head } = opts;
  if ((against === undefined) === (base === undefined)) {
    log.error("exactly one of --against or --base is required");
    process.exit(2);
  }
  if (against !== undefined) {
    if (head !== undefined) {
      log.error("--head cannot be combined with --against — use --base/--head or --against alone");
      process.exit(2);
    }
    const parsed = parseAgainstRange(against);
    if (!parsed) {
      log.error(
        `invalid --against "${against}": expected "<base>..<head>" (two-dot range; three-dot "a...b" is not accepted)`,
      );
      process.exit(2);
    }
    return parsed;
  }
  // The XOR check above guarantees base is defined whenever against isn't.
  return { base: base!, head: head ?? DEFAULT_HEAD };
}

/**
 * Split on the FIRST `..`, so a head like `HEAD` or a ref containing dots
 * (`v1.2.3`) still parses. This also catches git's three-dot syntax
 * (`a...b`): splitting on the first `..` there leaves a head starting with
 * `.`, rejected the same as an actually-empty one.
 */
export function parseAgainstRange(value: string): { base: string; head: string } | null {
  const i = value.indexOf("..");
  if (i < 0) return null;
  const base = value.slice(0, i);
  const rangeHead = value.slice(i + 2);
  if (!base || !rangeHead || rangeHead.startsWith(".")) return null;
  return { base, head: rangeHead };
}

/**
 * Resolve `--repo`, relative to `cwd` (the `.ccqa` root) like `--report-dir`.
 * Validated eagerly rather than left to `getChangedFilesBetween`'s own git
 * failure: a bad `--repo` is a usage error, and "failed to run git diff"
 * would misname the actual problem.
 */
async function resolveRepo(repoOpt: string | undefined, cwd: string): Promise<string> {
  if (repoOpt === undefined) return cwd;
  const repo = resolve(cwd, repoOpt);
  const exists = await stat(repo)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    log.error(`--repo path does not exist: ${repo}`);
    process.exit(2);
  }
  try {
    await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd: repo });
  } catch (e) {
    log.error(`--repo is not a git repository: ${repo} (${errMessage(e)})`);
    process.exit(2);
  }
  return repo;
}

const VERDICT_ORDER: SelectVerdict[] = ["needed", "unknown", "notNeeded"];

function renderText(report: SelectReport): string {
  const lines: string[] = [];
  for (const verdict of VERDICT_ORDER) {
    const rows = report.specs.filter((s) => s.verdict === verdict);
    if (rows.length === 0) continue;
    lines.push("", `${verdict} (${rows.length})`);
    for (const row of rows) {
      lines.push(`  ${row.featureName}/${row.specName}`);
      lines.push(`    ${row.reason}`);
      if (row.touchedBy?.length) lines.push(`    ← ${row.touchedBy.join(", ")}`);
    }
  }
  if (report.uncoveredFiles.length > 0) {
    lines.push("", `uncovered (${report.uncoveredFiles.length})`);
    for (const file of report.uncoveredFiles) lines.push(`  ${file}`);
  }
  // Said, because it is the difference between "no spec reaches this" and
  // "the project declared this file's changes carry no signal".
  if (report.excludedFiles > 0) {
    lines.push("", `excluded by coverage.exclude (${report.excludedFiles})`);
  }
  const toRun = specsToRun(report).length;
  lines.push("", `${toRun} of ${report.specs.length} spec(s) to run (needed + unknown)`, "");
  return lines.join("\n");
}

/**
 * One test file path per selected spec, deduplicated, in report order —
 * meant to be passed straight to a test runner as arguments. A spec whose
 * target couldn't be resolved (`testPath === ""`, see `SpecDescription`) is
 * dropped rather than emitting a blank line.
 */
export function renderPaths(report: SelectReport): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const spec of specsToRun(report)) {
    if (!spec.testPath || seen.has(spec.testPath)) continue;
    seen.add(spec.testPath);
    lines.push(spec.testPath);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function parseFormat(raw: string | undefined): "text" | "json" | "paths" {
  const value = raw ?? "text";
  if (value === "text" || value === "json" || value === "paths") return value;
  log.error(`invalid --format: ${value} (expected text|json|paths)`);
  process.exit(2);
}
