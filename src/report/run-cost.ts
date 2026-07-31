import { readCostTally } from "../claude/cost-tally.ts";
import { toReportCost } from "../claude/to-report-cost.ts";
import type { ReportCost } from "./schema.ts";

/**
 * What the running command has spent on Claude so far, in the report's shape.
 *
 * Null outside a `withCostTally` scope — a library caller of `executeRun`, or a
 * unit test — which is not the same as "spent nothing".
 */
export function currentReportCost(): ReportCost | null {
  const cost = readCostTally();
  return cost === null ? null : toReportCost(cost);
}
