import { Command } from "commander";
import {
  DEFAULT_REPORT_DIR,
  EVIDENCE_SUBDIR,
  REPORT_FORMATS,
  type ReportFormat,
} from "../run/report-constants.ts";
import {
  executeRun,
  RunUsageError,
  type RunOptions,
} from "../run/pipeline.ts";
import { addHubOptions, addLanguageOption, addProfileOption } from "./options.ts";
import { resolveCwd } from "./resolve-cwd.ts";
import { createRunTeardown, installTeardownSignalHandlers } from "./run-teardown.ts";
import * as log from "./logger.ts";

export {
  buildFailureLog,
  failedSpec,
  TailBuffer,
  type ReportFormat,
  type RunOptions,
  type SpecRunSummary,
} from "../run/pipeline.ts";

export const runCommand = addHubOptions(addProfileOption(addLanguageOption(
  new Command("run")
    .argument(
      "[targets...]",
      "Specs to run, space-separated: each '<feature>/<spec>', '<feature>', or omit for all. Duplicates are de-duped.",
    )
    .description(
      "Run specs. Each spec's execution mode comes from its spec.yaml `mode:` field " +
        "(default deterministic; set `mode: live` to have Claude drive agent-browser live per step). " +
        "Deterministic specs replay the recorded test.spec.ts under vitest. " +
        "A structured report (report.json + evidence) is always written; use --push-report to also stream it to a hub.",
    )
    .option(
      "--report [dir]",
      `Directory for the structured run results (report.json + evidence PNGs) that are always written. Default: ${DEFAULT_REPORT_DIR}/. Pass this only to change the location.`,
    )
    .option(
      "--push-report",
      "Incrementally push the run report to the hub as the run progresses (open → patch per spec → finalize). Requires --hub-url/--hub-token (or CCQA_HUB_URL/CCQA_HUB_TOKEN). Without it, hub credentials are used only to fetch variables/sessions/prompts, not to push.",
    )
    .option(
      "--changed [base]",
      "Restrict execution to specs whose relatedPaths intersect the git diff against [base]. Without a value the base comes from $GITHUB_BASE_REF (pull_request CI); elsewhere pass it explicitly (e.g. --changed=origin/main). Cannot be combined with an explicit spec id.",
    )
    .option(
      "--failure-analysis [base]",
      "Classify each failure (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG) against the source diff since [base]. Without a value the base comes from $GITHUB_BASE_REF (pull_request CI); elsewhere pass it explicitly (e.g. --failure-analysis=origin/main), or pass 'last-green' to diff each spec against the commit where it last passed (per-spec baselines from the hub; requires a hub connection). Off by default — no Claude calls without it.",
    )
    .option(
      "--no-drift-audit",
      "With --failure-analysis: skip the spec↔code drift audit shown in the report.",
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
    )
    .option(
      "--update-agent-prompt",
      "(live only) After the run finishes, ask Claude to refresh the \"live.agent\" prompt on the hub from a summary of the run. Requires a hub connection.",
    )
    .option(
      "--concurrency <n>",
      "Run up to N specs in parallel within each mode (deterministic / live). Default 1 (sequential). Live specs each get an isolated agent-browser session; high values spawn many headed Chrome instances.",
      parseConcurrency,
      1,
    )
    .option(
      "--project <name>",
      "Project name for the hub. Defaults to the current directory's name.",
    ),
))).action(async (targets: string[], opts: RunOptions) => {
  await runCliAction(targets, opts);
});

/** Parse --concurrency: a positive integer. Rejects 0, negatives, non-integers. */
function parseConcurrency(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    log.error(`invalid --concurrency: ${raw} (expected positive integer)`);
    process.exit(2);
  }
  return n;
}

/** Header label shown after `ccqa run`: the lone target, a count, or a mode marker. */
function headerTarget(targets: string[], opts: RunOptions): string {
  if (targets.length === 1) return targets[0]!;
  if (targets.length > 1) return `${targets.length} targets`;
  return opts.changed ? "(changed)" : "(all specs)";
}

/**
 * CLI entry point: calls the library pipeline and maps its result back to a
 * process exit code. This is the only place in the `run` command that calls
 * `process.exit` — `executeRun` itself never does.
 */
async function runCliAction(targets: string[], opts: RunOptions): Promise<void> {
  log.header("run", headerTarget(targets, opts));

  const cwd = resolveCwd(opts.cwd);

  const teardown = createRunTeardown();
  const disposeSignalHandlers = installTeardownSignalHandlers(teardown);
  try {
    const result = await executeRun(targets, { ...opts, cwd, teardown });
    // Reap tracked sessions on the normal exit path too — the signal handler
    // only covers SIGINT/SIGTERM. run() is idempotent, so no risk of a
    // double-reap if a signal arrives right around here.
    await teardown.run();
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof RunUsageError) {
      log.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  } finally {
    disposeSignalHandlers();
  }
}
