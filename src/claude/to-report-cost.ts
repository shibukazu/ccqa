import type { ReportCost } from "../report/schema.ts";
import type { ClaudeInvocationCost } from "./invoke.ts";

/**
 * Narrow an invocation's cost to the shape the report carries.
 *
 * The two differ by exactly one field — the report keeps only the API-time
 * figure, not `durationMs` — so this is a rest-spread rather than a
 * field-by-field copy: a field added to `ClaudeInvocationCost` and to
 * `ReportCost` then flows through without an edit here, and one added to only
 * the former fails to compile. Written out by hand, the same growth would
 * silently drop the new field, and per-step and run-level cost would stop
 * describing the same thing.
 */
export function toReportCost(cost: ClaudeInvocationCost): ReportCost {
  const { durationMs: _durationMs, ...rest } = cost;
  return rest;
}
