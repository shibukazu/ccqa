import { generateSessionName } from "../prompts/trace.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
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
  /** The case's recorded undo, attempted after a route that replayed whole. */
  cleanup?: RecordedAction[];
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
  // One fresh value, seen by every action in this replay: the fill that types
  // it, the assertion that reads it back, the click that acts on it. `ir.json`
  // keeps the reference — the value belongs to this replay.
  const envOverrides = { CCQA_RUN_ID: buildRunId() };
  const replay = (actions: RecordedAction[]) =>
    validateActions(actions, {
      sessionName,
      mode: "strict",
      envOverrides,
      onProgress: (i, total, action) => log.progress(i, total, action.action),
    });
  // A route that names a thing after this run is a route that makes one, and
  // this check just made it too.
  const makesSomething = input.recording.some((a) => a.value?.includes("CCQA_RUN_ID"));
  const cleanup = input.cleanup ?? [];

  let dropped: ValidationDrop[];
  let promoted: string[] = [];
  let cleanupPromoted: string[] = [];
  try {
    log.info(
      `replaying ${input.recording.length} recorded action(s) against the application ` +
        `to check the route still holds...`,
    );
    const route = replay(input.recording);
    dropped = route.dropped;
    promoted = route.promoted ?? [];
    // Only after a route that replayed whole. A cleanup locator is rarely
    // scoped to the run id, so undoing a route that created nothing removes
    // whatever was already there.
    if (cleanup.length > 0 && dropped.length === 0) {
      log.info(`replaying the ${cleanup.length} recorded cleanup action(s)...`);
      const undone = replay(cleanup);
      cleanupPromoted = undone.promoted ?? [];
      if (undone.dropped.length > 0) {
        // Cascade victims were never attempted, so naming one as left behind
        // points at an action that changed nothing.
        const failed = undone.dropped.filter((d) => !isCascadeReason(d.reason));
        log.warn(
          `the recorded cleanup did not fully replay (${failed.length || undone.dropped.length} ` +
            `action(s)) — this check may have left ` +
            `${describeStepAction((failed[0] ?? undone.dropped[0]!).action)} behind`,
        );
      }
    }
  } finally {
    log.progressEnd();
    void (input.teardown?.closeTracked(sessionName) ?? closeSession(sessionName));
  }
  // The fallback rewrote the actions in place, so the generation about to
  // happen already uses them. Saved as well, or the route on disk keeps the
  // locator that does not replay and every later command asks again.
  const learned = [...promoted, ...cleanupPromoted];
  if (learned.length > 0) {
    for (const p of learned) log.info(formatPromotion(p));
    await rewriteRecordingActions(
      input.ref,
      input.recording,
      cleanupPromoted.length > 0 ? cleanup : undefined,
    );
  }
  if (dropped.length === 0) {
    if (makesSomething && cleanup.length === 0) {
      log.warn(
        "this case records no cleanup, so what the check just created is still in the application",
      );
    }
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
    (makesSomething && cleanup.length > 0
      ? `The recorded cleanup was not attempted — check the application for anything this left behind.\n`
      : "") +
    `Re-record with 'ccqa record ${input.ref.id}'. Pass --no-replay to regenerate from the ` +
    `saved route anyway (e.g. with no browser or no variables in this environment).`
  );
}
