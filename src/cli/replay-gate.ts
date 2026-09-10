import { generateSessionName } from "../prompts/trace.ts";
import {
  assertAgentBrowserAvailable,
  AgentBrowserUnavailableError,
  formatAgentBrowserUnavailableMessage,
} from "../runtime/agent-browser-bin.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import {
  formatPromotion,
  isCascadeReason,
  validateActions,
  type ValidationDrop,
} from "../runtime/replay-validate.ts";
import { describeStepAction } from "../ir/route-diff.ts";
import { resolve } from "node:path";
import { loadStateIntoSession } from "../runtime/session-state.ts";
import { rewriteRecordingActions, type CaseRef } from "../store/index.ts";
import type { RecordedAction } from "../ir/types.ts";
import type { RunTeardown } from "./run-teardown.ts";
import * as log from "./logger.ts";

/**
 * What `ccqa generate` checks before recompiling a saved recording.
 *
 * Regenerating from `ir.json` is cheap and browser-free, which is the point:
 * when a page object or a convention changes, every spec can be re-emitted
 * without paying for a trace. That only holds while the recording still
 * describes reality — an application that has moved leaves a route no amount
 * of re-emitting turns back into a passing test. So the route is replayed
 * first, and a dead one is refused rather than compiled.
 *
 * A refusal, not a warning: a warning here is read after the file is gone.
 *
 * There is deliberately no check for "was this test hand-edited". Answering it
 * needs a record of what the last generation wrote, which is the ledger
 * ADR-0028 removed — and the two facts available instead, the test's and the
 * recording's timestamps, cannot tell a human's edit from `ccqa generate`'s
 * own, since generate rewrites the test and never touches the recording. The
 * overwrite prompt in `ccqa generate` is what guards an edited test.
 */

export interface ReplayGateInput {
  ref: CaseRef;
  cwd: string;
  /** The saved route about to be recompiled. */
  recording: RecordedAction[];
  /**
   * The project's saved browser state (config `sessionState`), restored the
   * same way `ccqa record` restores it. Without it a case whose precondition
   * is "signed in" replays against a sign-in wall, every action fails, and the
   * gate refuses a route that is perfectly good.
   */
  sessionState?: string;
  teardown?: RunTeardown;
}

/**
 * A run's unique value belongs to the run that recorded it: the record it
 * created is not there now, and nothing can conjure it. An action that carries
 * the reference is therefore not replayable, and its failure says nothing
 * about whether the route still holds — so the gate does not ask.
 */
function replayable(action: RecordedAction): boolean {
  const texts = [action.value, action.locator?.value, action.target?.value];
  return !texts.some((t) => typeof t === "string" && t.includes("${CCQA_RUN_ID}"));
}

/**
 * Replay the saved route once against a fresh browser session, and answer with
 * the reason regeneration is refused — or null when the route still holds. No
 * model is involved: the recording already says what to do, and this only asks
 * whether doing it still works.
 */
export async function checkRecordedRouteReplays(
  input: ReplayGateInput,
): Promise<string | null> {
  if (input.recording.length === 0) return null;
  try {
    assertAgentBrowserAvailable();
  } catch (e) {
    if (!(e instanceof AgentBrowserUnavailableError)) throw e;
    // Refuse rather than skip: the check exists because a saved route can be
    // dead, and silently regenerating an unverified one is what it prevents.
    return (
      `the recorded route cannot be replayed here.\n${formatAgentBrowserUnavailableMessage()}\n` +
      `Pass --no-replay to regenerate from the saved route without checking it.`
    );
  }
  const sessionName = `${generateSessionName()}-regen`;
  input.teardown?.trackSession(sessionName);
  if (input.sessionState) {
    const injected = loadStateIntoSession(
      sessionName,
      resolve(input.cwd, input.sessionState),
    );
    if (!injected.ok) {
      return (
        `could not restore ${input.sessionState} to check the recorded route: ` +
        `${injected.error ?? "unknown error"}. Pass --no-replay to regenerate without checking it.`
      );
    }
  }
  const replayed = input.recording.filter(replayable);
  const skipped = input.recording.length - replayed.length;
  log.info(
    `replaying ${replayed.length} recorded action(s) to check the route still holds` +
      (skipped > 0 ? ` (${skipped} carry this run's unique value and cannot be replayed)` : "") +
      "...",
  );
  let dropped: ValidationDrop[];
  let promoted: string[] | undefined;
  try {
    ({ dropped, promoted } = validateActions(replayed, {
      sessionName,
      mode: "strict",
      onProgress: (i, total, action) => log.progress(i, total, action.action),
    }));
  } finally {
    log.progressEnd();
    void (input.teardown?.closeTracked(sessionName) ?? closeSession(sessionName));
  }
  // The fallback rewrote the actions in place, so the generation about to
  // happen already uses them. Saved as well, or the route on disk keeps the
  // locator that does not replay and every later command asks again.
  if (promoted !== undefined && promoted.length > 0) {
    for (const p of promoted) log.info(formatPromotion(p));
    await rewriteRecordingActions(input.ref, input.recording);
  }
  if (dropped.length === 0) {
    log.meta("replay", "route still holds");
    return null;
  }
  // One action failing takes the rest of its step with it, so the count alone
  // reads as a route that broke everywhere. What a reader needs first is the
  // action that actually failed; the rest is the size of its wake.
  const failed = dropped.filter((d) => !isCascadeReason(d.reason));
  const cascaded = dropped.length - failed.length;
  const first = failed[0] ?? dropped[0]!;
  const failures = (failed.length > 0 ? failed : dropped)
    .slice(0, 5)
    .map((d) => `  - ${describeStepAction(d.action)} — ${d.reason}`)
    .join("\n");
  return (
    `the recorded route no longer replays. The first action that failed is ` +
    `${describeStepAction(first.action)}` +
    (cascaded > 0 ? `, and ${cascaded} later action(s) were not replayed at all` : "") +
    `:\n${failures}\n` +
    `Re-record with 'ccqa record ${input.ref.id}'. Pass --no-replay to regenerate from the ` +
    `saved route anyway (e.g. with no browser or no variables in this environment).`
  );
}
