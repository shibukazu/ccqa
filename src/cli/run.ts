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
      "Run specs, on any target. Agent-browser specs replay the recorded test.spec.ts under vitest " +
        "(default), or, with spec.yaml `mode: live`, have Claude drive agent-browser live per step. " +
        "External-target specs (playwright, runn) run through the target's configured `runCommand`. " +
        "A structured report (report.json + evidence) is always written; use --report-to-hub to also stream it to a hub.",
    )
    // Every `--only-*` narrows the set independently, so passing several ANDs
    // them. That is the point: "reached by this diff AND audited clean" is the
    // combination CI wants, and a single mode enum cannot express it.
    .optionsGroup("Which specs to run:")
    .option(
      "--only-affected-by <ref>",
      "Only specs `ccqa select-specs` judges reached by the diff against <ref> (e.g. origin/main). In pull_request CI, pass $GITHUB_BASE_REF. Cannot be combined with an explicit spec id.",
    )
    .option(
      "--only-hub-stale",
      "Only specs the hub says are no longer covered by their last result — each spec's own last run compared against the hub's deploy log. No git diff involved. Requires a hub connection and --hub-profile.",
    )
    .option(
      "--only-hub-stale-with-unknown",
      "With --only-hub-stale: also take specs whose re-run need the hub cannot answer ('unknown') and specs that never ran ('neverRun'). Off by default: an unanswerable question is reported, not guessed.",
    )
    .option(
      "--only-hub-audited-clean",
      "Only specs the hub's drift ledger records as audited with no drift. A spec that has never been audited is not taken: this flag spends a run where a cheap audit already cleared the spec, and \"never looked\" is not that. Requires a hub connection.",
    )
    .option(
      "--dry-run",
      "Print the specs this invocation would run, then exit 0 without executing anything and without writing a report. Works with every selection flag.",
    )
    .optionsGroup("How to run them:")
    .option(
      "--concurrency <n>",
      "Run up to N specs in parallel within each phase (deterministic / external-target / live), never across phases. Default 1 (sequential). Live specs each get an isolated agent-browser session; high values spawn many headed Chrome instances.",
      parseConcurrency,
      1,
    )
    .option(
      "-m, --model <name>",
      "Claude model alias ('sonnet'|'opus'|'haiku') or full ID. Overrides CCQA_MODEL.",
    )
    .option(
      "--live-step-retry <n>",
      "(live only) Retry each failed step up to N more times before recording failure. This retries a step, not the whole spec — see --on-fail-explain-rerun for that.",
      (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
          throw new Error(`--live-step-retry must be a non-negative integer, got "${raw}"`);
        }
        return n;
      },
      0,
    )
    .option(
      "--live-artifacts-dir <dir>",
      "(live only) Override the per-spec artifact directory. Default: <specDir>/runs/<runId>. Ignored when running multiple specs.",
    )
    .option(
      "--replay-skip-evidence",
      `(deterministic replay only) Skip step-boundary evidence capture (PNG + meta JSON written to ${DEFAULT_REPORT_DIR}/${EVIDENCE_SUBDIR}/ by default).`,
    )
    .optionsGroup("What to do about failures:")
    .option(
      "--on-fail-explain",
      "Classify each failure against the source diff since the commit where that spec last passed (per-spec baselines from the hub). Off by default — no Claude calls without it.",
    )
    .option(
      "--on-fail-explain-base <ref>",
      "With --on-fail-explain: diff against <ref> instead of each spec's last green. Use when there is no hub to hold the baselines.",
    )
    .optionsGroup("What to do with the results:")
    .option(
      "--report-dir <dir>",
      `Directory for the structured run results (report.json + evidence PNGs), which are always written. Default: ${DEFAULT_REPORT_DIR}/.`,
    )
    .option(
      "--report-format <fmt>",
      "Additional output format alongside HTML: 'text' (default), 'json' (writes report.json), 'github' (GitHub Actions annotations on stdout).",
      (raw): ReportFormat => {
        if ((REPORT_FORMATS as readonly string[]).includes(raw)) return raw as ReportFormat;
        throw new Error(`--report-format must be one of ${REPORT_FORMATS.join(" | ")}`);
      },
      "text" as ReportFormat,
    )
    .option(
      "--report-to-hub",
      "Incrementally push the run report to the hub as the run progresses (open → patch per spec → finalize). Requires --hub-url/--hub-token (or CCQA_HUB_URL/CCQA_HUB_TOKEN). Without it, hub credentials are used only to fetch variables/sessions/prompts, not to push.",
    )
    .optionsGroup("Learning:")
    .option(
      "--learn-hub-live-prompt",
      "(live only) After the run finishes, ask Claude to refresh the \"live.agent\" prompt on the hub from a summary of the run. Requires a hub connection.",
    )
    // Last group wins for everything added after it, which is how the shared
    // --language / --hub-profile / --hub-* options land here too.
    .optionsGroup("Environment and connection:")
    .option(
      "--cwd <path>",
      "Working directory containing the .ccqa/ tree (monorepo support). Defaults to the current directory.",
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

/** Header label shown after `ccqa run`: the lone target, a count, or how they were selected. */
function headerTarget(targets: string[], opts: RunOptions): string {
  if (targets.length === 1) return targets[0]!;
  if (targets.length > 1) return `${targets.length} targets`;
  const filters = [
    opts.onlyAffectedBy ? "affected" : null,
    opts.onlyHubStale ? "stale" : null,
    opts.onlyHubAuditedClean ? "audited clean" : null,
  ].filter((s): s is string => s !== null);
  return filters.length === 0 ? "(all specs)" : `(${filters.join(" + ")})`;
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
