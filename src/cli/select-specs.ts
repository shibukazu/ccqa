import { Command } from "commander";
import { getChangedFilesBetween, type ChangedFile } from "../drift/affected.ts";
import { selectSpecs } from "../select/analyze.ts";
import { loadSpecInventory, type SpecDescription } from "../select/inventory.ts";
import { specsToRun, type SelectReport, type SelectVerdict } from "../select/types.ts";
import * as log from "./logger.ts";
import { resolveCwd } from "./resolve-cwd.ts";

interface SelectSpecsOptions {
  /** requiredOption — commander exits before the action runs if this is missing. */
  base: string;
  head?: string;
  cwd?: string;
  model?: string;
  format?: string;
}

const DEFAULT_HEAD = "HEAD";

export const selectSpecsCommand = new Command("select-specs")
  .description(
    "Decide which specs a range of commits reaches. Reads the diff and the spec inventory and returns one verdict per spec: needed | notNeeded | unknown.",
  )
  .requiredOption(
    "--base <ref>",
    "Commit the range starts at — typically what is currently deployed, or the previous commit on the branch.",
  )
  .option("--head <ref>", `Commit the range ends at (default: ${DEFAULT_HEAD})`)
  .option(
    "--cwd <path>",
    "Working directory used as both the .ccqa root and the codebase Claude reads. Changes outside it are reported but never attributed to a spec. Defaults to process.cwd().",
  )
  .option(
    "-m, --model <name>",
    "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
  )
  .option("--format <fmt>", "Output format: text | json", "text")
  .action(async (opts: SelectSpecsOptions) => {
    const format = parseFormat(opts.format);
    const cwd = resolveCwd(opts.cwd);
    const head = opts.head ?? DEFAULT_HEAD;

    // Independent inputs — the spec tree (fs) and the diff (a git
    // subprocess) — read concurrently rather than one after the other.
    const [specsResult, changedResult] = await Promise.all([
      loadSpecInventory(cwd).then(
        (specs) => ({ ok: true as const, specs }),
        (e: unknown) => ({ ok: false as const, error: e as Error }),
      ),
      getChangedFilesBetween(opts.base, head, cwd).then(
        (changed) => ({ ok: true as const, changed }),
        (e: unknown) => ({ ok: false as const, error: e as Error }),
      ),
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
      log.meta("changed-files", changed.length);
      log.meta("specs", specs.length);
    }

    const report = await selectSpecs({
      changed,
      specs,
      cwd,
      base: opts.base,
      head,
      ...(opts.model ? { model: opts.model } : {}),
    });

    process.stdout.write(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
    process.exit(0);
  });

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
