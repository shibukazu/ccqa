import { takeScreenshot, type ScreenshotResult } from "./screenshot.ts";
import { reviveSession } from "./session-state.ts";
import * as log from "../cli/logger.ts";

export interface RecoveredScreenshotInput {
  sessionName: string;
  outPath: string;
  /** How the step names this frame in the log, e.g. `after, step-01`. */
  label: string;
  fullPage?: boolean;
  statePath: string | null;
  verifyUrl: string | null;
  /**
   * Whether this step has already spent its one recovery. Shared with the
   * executor's own health check: reviving costs a SIGTERM poll and a reboot of
   * the application that just wedged, and one step is worth one of those
   * however many probes noticed.
   */
  recovery: { spent: boolean };
}

/**
 * A step's screenshot, retaken once if the daemon never answered. The retake is
 * viewport-only — a full page is what the daemon choked on — and it shows the
 * page the recovery anchored to, not where the step ended, which the log says.
 */
export async function screenshotWithRecovery(
  input: RecoveredScreenshotInput,
): Promise<ScreenshotResult> {
  const first = takeScreenshot(input.sessionName, input.outPath, {
    ...(input.fullPage === true ? { fullPage: true } : {}),
  });
  if (first.wedged !== true || input.recovery.spent) return first;

  input.recovery.spent = true;
  const revived = await reviveSession(
    input.sessionName,
    input.statePath,
    input.verifyUrl,
    `screenshot (${input.label}) found the session unresponsive`,
  );
  if (!revived) return first;

  const retaken = takeScreenshot(input.sessionName, input.outPath);
  if (!retaken.ok) return retaken;
  log.warn(`screenshot (${input.label}) is the page the session was recovered to, not where the step ended`);
  // A full page was asked for and a viewport frame is what this is, same as
  // the fallback inside `takeScreenshot` — so it is said the same way.
  return input.fullPage === true ? { ...retaken, degraded: true } : retaken;
}
