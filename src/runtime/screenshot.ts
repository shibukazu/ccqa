import { spawnAB } from "./spawn-ab.ts";

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  error?: string;
}

export interface ScreenshotOptions {
  /**
   * Capture the full scrollable page instead of just the viewport. Use for
   * "after" shots so the assertion target (e.g. a row added below the fold) is
   * guaranteed to be in the artifact regardless of scroll position.
   */
  fullPage?: boolean;
  /**
   * Absolute path to a saved auth-state file (as produced by
   * `agent-browser state save`). When set, the screenshot subprocess is
   * launched with `--state <statePath>` so it attaches to the same
   * pre-authenticated origin the live executor is driving — without it the
   * spawned agent-browser would open a fresh, signed-out browser and the
   * screenshot would miss the live page state.
   *
   * The flag is load-only; agent-browser never writes back to this file.
   */
  statePath?: string | null;
}

/**
 * Take a PNG screenshot of the current page in the given agent-browser session
 * and write it to `outPath`. Used by `ccqa run` (live mode) to capture per-step
 * artifacts (before / after the step's actions) so the human-readable run
 * report has a visual trail even though no AB_ACTION stream is recorded.
 *
 * Failures (no session, daemon unavailable, agent-browser exit non-zero) are
 * swallowed and surfaced as `{ ok: false, error }` — the caller logs the miss
 * and continues. We never throw, because a missing screenshot is a degraded
 * artifact, not a reason to abort the test step.
 */
export function takeScreenshot(
  sessionName: string,
  outPath: string,
  options?: ScreenshotOptions,
): ScreenshotResult {
  const args = ["--session", sessionName];
  if (options?.statePath) args.push("--state", options.statePath);
  args.push("screenshot");
  if (options?.fullPage) args.push("--full");
  args.push(outPath);
  const res = spawnAB(args);
  if (res.status === 0) {
    return { ok: true, path: outPath };
  }
  const error = (res.stderr || res.stdout || `exit ${res.status ?? "null"}`).trim();
  return { ok: false, path: outPath, error };
}
