import type { SpecResult, Threshold } from "./types.ts";

/**
 * Map drift results to an exit code. Spec-level errors (Claude call failed)
 * always fail; otherwise ERROR severity always fails, WARN fails only when
 * the threshold is `warn`.
 */
export function determineExitCode(results: SpecResult[], threshold: Threshold): number {
  for (const r of results) {
    if (r.error) return 1;
    for (const issue of r.issues) {
      if (issue.severity === "ERROR") return 1;
      if (threshold === "warn" && issue.severity === "WARN") return 1;
    }
  }
  return 0;
}
