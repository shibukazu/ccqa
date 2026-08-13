import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { readCostFileTotal } from "../../src/cli/cost-line.ts";
import { CcqaTimeoutError, devCcqaCommand, runCcqa, type RunCcqaResult } from "../../tests/e2e/_helpers/cli.ts";
import { filterCases, listFixtureSpecKeys, loadCases, type EvalCase } from "./cases.ts";
import { buildCaseRepo, type CaseRepo } from "./fixture-repo.ts";
import {
  DEFAULT_APP_DIR,
  DEFAULT_CASES_DIR,
  DEFAULT_RESULTS_DIR,
  writeResultFile,
  type ResultMeta,
} from "./results.ts";

export interface EvalOptions {
  model?: string;
  /** Substring filter on case names. */
  filter?: string;
  /** Where the case YAMLs live; the wiring test points this at its own fixtures. */
  casesDir?: string;
  resultsDir?: string;
  /** Extra env for the ccqa subprocesses; the wiring test injects the Claude mock here. */
  env?: Record<string, string>;
  quiet?: boolean;
}

export interface EvalCaseResult<TOutcome> {
  name: string;
  title: string;
  outcomes: TOutcome[];
  /** Set when the model never produced a scoreable answer; excluded from the aggregate. */
  abandoned?: true;
}

/**
 * A case the model failed to answer even after the runner's retry. Thrown by
 * a `runCase` instead of scoring, caught by the loop: the case is recorded as
 * abandoned and the run continues — one flaky reply must not cost the rest of
 * a paid run, and an abandoned case must never count as a correct answer.
 */
export class CaseAbandonedError extends Error {}

export interface EvalSummary<TOutcome, TAggregate> {
  meta: ResultMeta;
  cases: EvalCaseResult<TOutcome>[];
  aggregate: TAggregate;
  resultPath: string;
}

export interface CaseContext {
  evalCase: EvalCase;
  repo: CaseRepo;
  model: string;
  /** This working tree's ccqa (dev entry, ambient config scrubbed), spawned in the case repo. */
  ccqa: (args: string[]) => Promise<RunCcqaResult>;
}

export interface EvalDefinition<TOutcome, TAggregate> {
  kind: "audit" | "select";
  promptVersion: string | null;
  /** Run the command under test against one case and score it. Throws on a command failure — a failed run is never scored. */
  runCase: (ctx: CaseContext) => Promise<TOutcome[]>;
  aggregate: (outcomes: TOutcome[]) => TAggregate;
  /** The aggregate's key in the result file (`confusion` / `metrics`). */
  aggregateKey: "confusion" | "metrics";
  printSummary: (summary: EvalSummary<TOutcome, TAggregate>) => void;
}

/**
 * Ambient configuration that must not leak into an eval run: a developer's
 * hub connection would pull project guidance into the prompts under test, and
 * CCQA_MODEL would override the model the results file claims was used.
 * `CCQA_HUB_` is matched as a prefix, not a key list, so a new hub variable
 * is scrubbed without anyone re-auditing this line.
 */
function isAmbientCcqaKey(key: string): boolean {
  return key.startsWith("CCQA_HUB_") || key === "CCQA_MODEL";
}

const CCQA_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The loop both evals share: build each case's repo, run the command under
 * test in it, score, aggregate, write the result file. Cases run one at a
 * time — the commands already parallelize inside themselves, and a serial
 * outer loop keeps one case's failure attributable.
 */
export async function runEval<TOutcome, TAggregate>(
  def: EvalDefinition<TOutcome, TAggregate>,
  opts: EvalOptions = {},
): Promise<EvalSummary<TOutcome, TAggregate>> {
  const model = opts.model ?? "haiku";
  const resultsDir = opts.resultsDir ?? DEFAULT_RESULTS_DIR;

  const specKeys = await listFixtureSpecKeys(DEFAULT_APP_DIR);
  if (specKeys.length === 0) throw new Error(`no specs found under ${join(DEFAULT_APP_DIR, ".ccqa")}`);
  const cases = filterCases(await loadCases(opts.casesDir ?? DEFAULT_CASES_DIR, specKeys), def.kind, opts.filter);

  const say = (line: string) => {
    if (!opts.quiet) console.log(line);
  };
  const startedAt = new Date().toISOString();
  const costDir = await mkdtemp(join(tmpdir(), "ccqa-eval-cost-"));
  const costFile = join(costDir, "cost.jsonl");
  try {
    const results: EvalCaseResult<TOutcome>[] = [];
    let consecutiveAbandons = 0;
    for (const evalCase of cases) {
      say(`case ${evalCase.name} — ${evalCase.title}`);
      const repo = await buildCaseRepo(DEFAULT_APP_DIR, evalCase.mutations);
      try {
        const ccqa = (args: string[]) =>
          runCcqa(args, {
            cwd: repo.dir,
            command: devCcqaCommand(),
            timeoutMs: CCQA_TIMEOUT_MS,
            scrubEnv: isAmbientCcqaKey,
            env: { CCQA_COST_FILE: costFile, ...opts.env },
          });
        try {
          results.push({
            name: evalCase.name,
            title: evalCase.title,
            outcomes: await def.runCase({ evalCase, repo, model, ccqa }),
          });
          consecutiveAbandons = 0;
        } catch (err) {
          // A timeout is abandoned too: it is the shape a throttled account
          // takes (the CLI stalls at 0% CPU until the deadline), and one
          // stalled case must not cost the run what already completed.
          if (!(err instanceof CaseAbandonedError) && !(err instanceof CcqaTimeoutError)) throw err;
          say(`  abandoned: ${err.message}`);
          results.push({ name: evalCase.name, title: evalCase.title, outcomes: [], abandoned: true });
          consecutiveAbandons += 1;
        }
      } finally {
        await repo.cleanup();
      }
      // Two in a row is no longer one flaky reply — the environment itself is
      // stalled (throttling, network). Keep what completed instead of paying
      // the timeout again for every remaining case.
      if (consecutiveAbandons >= 2) {
        say("two consecutive abandons — stopping the run here; the remaining cases were not attempted");
        break;
      }
    }

    const aggregate = def.aggregate(results.flatMap((r) => r.outcomes));
    const meta: ResultMeta = {
      kind: def.kind,
      startedAt,
      model,
      promptVersion: def.promptVersion,
      cost: await readCostFileTotal(costFile),
    };
    const resultPath = await writeResultFile(resultsDir, meta, {
      cases: results,
      [def.aggregateKey]: aggregate,
    });
    const summary: EvalSummary<TOutcome, TAggregate> = { meta, cases: results, aggregate, resultPath };
    if (!opts.quiet) def.printSummary(summary);
    return summary;
  } finally {
    await rm(costDir, { recursive: true, force: true });
  }
}

/** The commander wiring both `eval:*` entries share: a case filter and a model flag. */
export async function runEvalCli(
  name: string,
  description: string,
  run: (opts: EvalOptions) => Promise<unknown>,
): Promise<void> {
  const program = new Command(name)
    .description(description)
    .argument("[filter]", "Only run cases whose name contains this substring.")
    .option("-m, --model <name>", "Claude model alias ('sonnet'|'opus'|'haiku') or full ID.", "haiku")
    .action(async (filter: string | undefined, opts: { model: string }) => {
      await run({ model: opts.model, ...(filter ? { filter } : {}) });
    });

  // `pnpm eval:audit -- --model x` forwards the literal `--`, which commander
  // reads as "everything after is positional" and rejects. A bare `--` never
  // means anything to these entries, so drop the first one wherever it sits.
  const argv = process.argv.slice();
  const dashDash = argv.indexOf("--", 2);
  if (dashDash !== -1) argv.splice(dashDash, 1);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
