import { spawnAB } from "./spawn-ab.ts";

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  error?: string;
  /** True when a full-page shot was asked for and a viewport one was taken. */
  degraded?: boolean;
  /**
   * The daemon did not answer at all. Nothing this module can do reaches it,
   * so the caller — which owns killing and rebooting a session — decides.
   */
  wedged?: boolean;
}

export interface ScreenshotOptions {
  /**
   * Capture the full scrollable page instead of just the viewport. Use for
   * "after" shots so the assertion target (e.g. a row added below the fold) is
   * guaranteed to be in the artifact regardless of scroll position.
   */
  fullPage?: boolean;
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
  const asked = options?.fullPage === true;
  const full = asked && !noFullPage.has(sessionName);
  const shot = capture(sessionName, outPath, full);
  if (shot.ok) return asked && !full ? { ...shot, degraded: true } : shot;
  if (!full) return shot;
  // A page too heavy to capture whole and a daemon that stopped answering look
  // identical from here, and they want opposite remedies — one a lighter frame,
  // the other a reboot. The cheap frame is the question: it comes back, and the
  // session was alive all along; it is cut off too, and `wedged` is earned.
  // A heavy application cannot always be captured whole, and a viewport frame
  // is worth far more than none.
  const viewport = capture(sessionName, outPath, false);
  if (!viewport.ok) return viewport;
  // Remembered only once the viewport shot has worked: that is the evidence
  // the session was alive and the full-page path is specifically what failed.
  // A dead or restarting daemon fails both, and must not cost the run every
  // later full-page shot.
  noFullPage.add(sessionName);
  return { ...viewport, degraded: true };
}

/** Sessions whose full-page capture failed once. See `takeScreenshot`. */
const noFullPage = new Set<string>();

/**
 * Well under the shared ceiling: a screenshot has no legitimate reason to take
 * half a minute, and every second past it is paid again on every later step.
 */
const SCREENSHOT_TIMEOUT_MS = 20_000;

function capture(sessionName: string, outPath: string, fullPage: boolean): ScreenshotResult {
  const args = ["--session", sessionName, "screenshot"];
  if (fullPage) args.push("--full");
  args.push(outPath);
  const res = spawnAB(args, { timeoutMs: SCREENSHOT_TIMEOUT_MS });
  if (res.status === 0) return { ok: true, path: outPath };
  const error = (res.stderr || res.stdout || `exit ${res.status ?? "null"}`).trim();
  return { ok: false, path: outPath, error, ...(res.wedged === true ? { wedged: true } : {}) };
}
