import { spawnAB } from "./spawn-ab.ts";

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * Take a PNG screenshot of the current page in the given agent-browser session
 * and write it to `outPath`. Used by `ccqa run-nd` to capture per-step
 * artifacts (before / after the step's actions) so the human-readable run
 * report has a visual trail even though no AB_ACTION stream is recorded.
 *
 * Failures (no session, daemon unavailable, agent-browser exit non-zero) are
 * swallowed and surfaced as `{ ok: false, error }` — the caller logs the miss
 * and continues. We never throw, because a missing screenshot is a degraded
 * artifact, not a reason to abort the test step.
 */
export function takeScreenshot(sessionName: string, outPath: string): ScreenshotResult {
  const args = ["--session", sessionName, "screenshot", outPath];
  const res = spawnAB(args);
  if (res.status === 0) {
    return { ok: true, path: outPath };
  }
  const error = (res.stderr || res.stdout || `exit ${res.status ?? "null"}`).trim();
  return { ok: false, path: outPath, error };
}
