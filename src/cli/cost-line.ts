import { appendFileSync } from "node:fs";
import type { ClaudeInvocationCost } from "../claude/invoke.ts";
import { readCostTally, withCostTally } from "../claude/cost-tally.ts";
import { formatLiveCost } from "../runtime/live-cost-format.ts";

/**
 * Report what this command spent on Claude: a human line on stderr, and — when
 * `CCQA_COST_FILE` is set — one JSON line appended to that file.
 *
 * stderr rather than stdout because `audit --report-format json` and
 * `select-specs` put machine-readable output on stdout, and a cost line mixed
 * into it breaks the consumer. Cost is diagnostics about the command, not its
 * output.
 *
 * No-op outside a `withCostTally` scope: a command that never opened one has no
 * number to report, which is not the same as having spent nothing.
 *
 * Reached through `withCostReporting`; exported for its own test.
 */
export function reportCost(command: string): void {
  const cost = readCostTally();
  if (cost === null) return;
  const summary = formatLiveCost(cost, { compact: false });
  if (summary) process.stderr.write(`[cost] ${summary}\n`);
  appendCostRecord(command, cost);
}

/**
 * Run a command's action inside a cost tally and report the total once, however
 * the command ends.
 *
 * Neither half covers the other. Commands that end deep inside themselves with
 * `process.exit` never unwind, so only the `exit` listener sees them — and both
 * it and `reportCost` are synchronous, so the report still lands. Commands that
 * return normally are past `withCostTally`'s scope by the time `exit` fires, so
 * only the `finally` can still read the tally.
 *
 * Exactly one of the two runs: the `finally` detaches the listener before
 * reporting, and a `process.exit` terminates before the `finally` is reached.
 *
 * A signal handler only reports if it was REGISTERED inside this scope. Node
 * creates the SIGINT/SIGTERM handle when its first listener is added and binds
 * the async context then, so a handler installed at module load would read an
 * empty tally and drop the whole report on interrupt. `run.ts` installs its
 * teardown handlers inside the callback for that reason.
 */
export async function withCostReporting<T>(command: string, fn: () => Promise<T>): Promise<T> {
  return withCostTally(async () => {
    const report = (): void => reportCost(command);
    process.once("exit", report);
    try {
      return await fn();
    } finally {
      process.off("exit", report);
      report();
    }
  });
}

/**
 * Append one JSONL record to `$CCQA_COST_FILE`. Appended, never truncated: a CI
 * job invokes ccqa several times (select-specs, audit, run) and the point of the
 * file is that one `jq -s 'map(.totalCostUsd)|add'` covers the whole job.
 *
 * Written even when `totalCostUsd` is null — that the command ran and was not
 * billed is itself the answer. Synchronous because every caller is about to
 * `process.exit`, which would drop a pending async write.
 */
function appendCostRecord(command: string, cost: ClaudeInvocationCost): void {
  const path = process.env.CCQA_COST_FILE;
  if (!path) return;
  const record = {
    command,
    at: new Date().toISOString(),
    totalCostUsd: cost.totalCostUsd,
    numTurns: cost.numTurns,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    cacheReadInputTokens: cost.cacheReadInputTokens,
    models: cost.models,
  };
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Telemetry must never fail the command it measures.
  }
}
