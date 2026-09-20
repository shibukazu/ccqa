import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVIDENCE_DIR_ENV, sanitizeStepId } from "./evidence-constants.ts";

/**
 * Step-boundary screenshot capture for a generated Playwright test, kept for
 * the tests that already import it.
 *
 * ccqa no longer emits these calls: a committed spec is plain
 * `@playwright/test`, its steps are `test.step` blocks, and the screenshots
 * are read back out of the run's trace afterwards
 * (`targets/playwright/trace-capture.ts`). The `ccqa/step-evidence` subpath
 * still ships, and `ccqa run` still points `CCQA_EVIDENCE_DIR` at the report,
 * so a spec generated before that change keeps producing its own — higher
 * fidelity — pairs until it is regenerated. Nothing writes new calls to it,
 * and the export goes in a later release.
 *
 * Two constraints shape the whole module:
 *
 *   - **No test-framework dependency.** The page handle is typed
 *     structurally, so ccqa never imports `@playwright/test` and a consumer
 *     installs nothing beyond ccqa itself. Any object exposing these three
 *     members works — including a Playwright `Page`.
 *   - **Never fail the user's test.** Capture is best-effort: every error is
 *     swallowed with a stderr note. A missing screenshot costs a frame in the
 *     report; it must never flip a passing spec to red.
 *
 * Capture is opt-in at runtime via `CCQA_EVIDENCE_DIR`, which only `ccqa run`
 * sets. Running the generated test directly (or through the generation-time
 * verify/fix loop) writes nothing.
 */

/**
 * The subset of a browser page this module needs. Structural by design — see
 * the module comment.
 */
export interface CcqaEvidencePage {
  screenshot(options: { path: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
}

/**
 * Caption recorded on the entry shot's metadata and cleared by
 * `ccqaStepAfter`. If the test dies inside the step, this is what survives —
 * so the report shows the failing step with the screen it started from,
 * marked failed, instead of dropping the step entirely.
 */
const INCOMPLETE_STEP_SUMMARY = "the test stopped inside this step (no closing screenshot)";

/**
 * Capture the screen as the step is entered. Pair with `ccqaStepAfter` at the
 * end of the same step.
 */
export async function ccqaStepBefore(
  page: CcqaEvidencePage,
  stepId: string,
  source: string,
): Promise<void> {
  const dir = process.env[EVIDENCE_DIR_ENV];
  if (!dir) return;
  const id = sanitizeStepId(stepId);
  const beforeFile = `${id}.before.png`;
  if (!(await capture(page, dir, beforeFile))) return;
  await writeMeta(page, dir, id, {
    stepId,
    source,
    pngFile: beforeFile,
    failureSummary: INCOMPLETE_STEP_SUMMARY,
  });
}

/**
 * Capture the screen as the step closes and finalise the step's metadata:
 * the closing shot becomes the step's primary screenshot, the entry shot (if
 * one was taken) rides along as `beforePngFile`, and the "did not complete"
 * caption written by `ccqaStepBefore` is cleared.
 *
 * If the closing shot itself fails, the step still COMPLETED — it just lost its
 * final frame. Rewrite the meta without the failure caption (keeping the entry
 * shot as the frame) so a passing step doesn't render red; the capture failure
 * is surfaced via the stderr warn in `capture()`.
 */
export async function ccqaStepAfter(
  page: CcqaEvidencePage,
  stepId: string,
  source: string,
): Promise<void> {
  const dir = process.env[EVIDENCE_DIR_ENV];
  if (!dir) return;
  const id = sanitizeStepId(stepId);
  const afterFile = `${id}.png`;
  const beforeFile = `${id}.before.png`;
  const hasBefore = existsSync(join(dir, beforeFile));
  if (!(await capture(page, dir, afterFile))) {
    // Closing shot failed but the step finished — clear ccqaStepBefore's
    // "stopped inside this step" caption so it isn't marked failed. Keep the
    // entry shot as the step's frame when one was taken; if not, there is no
    // meta to correct.
    if (hasBefore) await writeMeta(page, dir, id, { stepId, source, pngFile: beforeFile });
    return;
  }
  await writeMeta(page, dir, id, {
    stepId,
    source,
    pngFile: afterFile,
    ...(hasBefore ? { beforePngFile: beforeFile } : {}),
  });
}

/** Screenshot into `<dir>/<file>`; false when the shot could not be taken. */
async function capture(page: CcqaEvidencePage, dir: string, file: string): Promise<boolean> {
  try {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, file) });
    return true;
  } catch (e) {
    warn(`screenshot failed for ${file} (${message(e)})`);
    return false;
  }
}

/**
 * Write the step's meta sidecar. `url`/`title` are read here rather than by
 * the caller so a page that cannot answer them still yields a usable record
 * (the screenshot alone is worth keeping).
 */
async function writeMeta(
  page: CcqaEvidencePage,
  dir: string,
  id: string,
  fields: Record<string, string>,
): Promise<void> {
  let url: string | null = null;
  let title: string | null = null;
  try {
    url = page.url();
    title = await page.title();
  } catch {
    // Page closed or navigating — the screenshot is already on disk.
  }
  const meta = { ...fields, url, title, capturedAt: new Date().toISOString() };
  try {
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch (e) {
    warn(`meta write failed for ${id} (${message(e)})`);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function warn(text: string): void {
  process.stderr.write(`[ccqa] step-evidence: ${text}\n`);
}
