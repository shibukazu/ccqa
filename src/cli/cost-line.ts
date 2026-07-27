import { readCostTally } from "../claude/cost-tally.ts";
import { formatLiveCost } from "../runtime/live-cost-format.ts";

/**
 * Write what this command spent on Claude to stderr.
 *
 * stderr rather than stdout because `drift --format json` and `select-specs`
 * put machine-readable output on stdout, and a cost line mixed into it breaks
 * the consumer. Cost is diagnostics about the command, not its output.
 */
export function reportCost(): void {
  const cost = readCostTally();
  if (cost === null) return;
  const summary = formatLiveCost(cost, { compact: false });
  if (summary) process.stderr.write(`[cost] ${summary}\n`);
}
