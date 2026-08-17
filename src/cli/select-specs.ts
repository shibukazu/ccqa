import { Command } from "commander";
import { getChangedFilesBetween, type ChangedFile } from "../drift/affected.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadCoverageEdges } from "../select/coverage-edges.ts";
import { loadSpecInventory, type SpecDescription } from "../select/inventory.ts";
import { specsToRun, type SelectReport, type SelectVerdict } from "../select/types.ts";
import { hubHeaderOption, hubTokenOption, hubUrlOption, resolveHubClient, type HubConnOptions } from "./hub-conn.ts";
import * as log from "./logger.ts";
import { needsHubConnection } from "./open-hub-run.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { resolveProject } from "./resolve-project.ts";

interface SelectSpecsOptions extends HubConnOptions {
  /** requiredOption — commander exits before the action runs if this is missing. */
  base: string;
  head?: string;
  cwd?: string;
  project?: string;
  format?: string;
}

const DEFAULT_HEAD = "HEAD";

export const selectSpecsCommand = new Command("select-specs")
  .description(
    "Decide which specs a range of commits reaches. Intersects the diff with each spec's last " +
      "measured reach from the hub (`ccqa run --coverage`) and returns one verdict per spec: " +
      "needed | notNeeded | unknown. Requires a hub connection; a spec with no measurement is unknown, which runs.",
  )
  .requiredOption(
    "--base <ref>",
    "Commit the range starts at — typically what is currently deployed, or the previous commit on the branch.",
  )
  .option("--head <ref>", `Commit the range ends at (default: ${DEFAULT_HEAD})`)
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
  .option("--format <fmt>", "Output format: text | json", "text")
  .action(runSelectSpecs);

async function runSelectSpecs(opts: SelectSpecsOptions): Promise<void> {
  const format = parseFormat(opts.format);
  const cwd = resolveCwd(opts.cwd);
  const head = opts.head ?? DEFAULT_HEAD;

  // The verdicts rest on measured reach stored on the hub, so no hub means
  // no decision — checked before any local work is spent.
  const hub = resolveHubClient(opts);
  if (!hub) {
    log.error(needsHubConnection("select-specs"));
    process.exit(2);
  }
  const project = resolveProject({ project: opts.project, cwd: opts.cwd });

  // Independent inputs — the spec tree (fs), the diff (a git subprocess) and
  // the coverage edges (the hub) — read concurrently rather than in sequence.
  const [specsResult, changedResult, edges] = await Promise.all([
    loadSpecInventory(cwd).then(
      (specs) => ({ ok: true as const, specs }),
      (e: unknown) => ({ ok: false as const, error: e as Error }),
    ),
    // Renames stay delete + add: the diff is intersected with reach measured
    // before the rename, and only the old path can match an edge.
    getChangedFilesBetween(opts.base, head, cwd, { detectRenames: false }).then(
      (changed) => ({ ok: true as const, changed }),
      (e: unknown) => ({ ok: false as const, error: e as Error }),
    ),
    loadCoverageEdges({ hub, project }),
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
    log.error(`failed to run 'git diff ${opts.base}..${head}': ${changedResult.error.message}`);
    process.exit(2);
  }
  const changed: ChangedFile[] = changedResult.changed;

  if (format === "text") {
    log.header("select-specs", `${opts.base} → ${head}`);
    if (opts.cwd) log.meta("cwd", cwd);
    log.meta("project", project);
    log.meta("changed-files", changed.length);
    log.meta("specs", specs.length);
    log.meta("measured-specs", edges.size);
  }

  const report = await selectSpecs({ changed, specs, cwd, base: opts.base, head, edges });

  process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  process.exit(0);
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
  const toRun = specsToRun(report).length;
  lines.push("", `${toRun} of ${report.specs.length} spec(s) to run (needed + unknown)`, "");
  return lines.join("\n");
}

function parseFormat(raw: string | undefined): "text" | "json" {
  const value = raw ?? "text";
  if (value === "text" || value === "json") return value;
  log.error(`invalid --format: ${value} (expected text|json)`);
  process.exit(2);
}
