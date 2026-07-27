import { driftSeverity, type SpecResult, type Threshold } from "./types.ts";

/**
 * Map drift results to an exit code. Spec-level errors (Claude call failed)
 * always fail; otherwise a diagnosis at `error` severity always fails, `warn`
 * fails only when the threshold is `warn`.
 */
export function determineExitCode(results: SpecResult[], threshold: Threshold): number {
  for (const r of results) {
    if (r.error) return 1;
    if (!r.drift) continue;
    const severity = driftSeverity(r.drift.label);
    if (severity === "error") return 1;
    if (threshold === "warn" && severity === "warn") return 1;
  }
  return 0;
}
