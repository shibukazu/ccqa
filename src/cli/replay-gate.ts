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
    // Every recorded action, unstable-marked ones included — discounted at
    // judgment (see `realFailures`' docstring below), not skipped here.
    const replayed = replay(input.recording);
    dropped = replayed.dropped;
    promoted = replayed.promoted ?? [];
    // Only after a route that replayed whole. A cleanup locator is rarely
    // scoped to the run id, so undoing a route that created nothing removes
    // whatever was already there.
    if (cleanup.length > 0 && dropped.length === 0) {
      log.info(`replaying the ${cleanup.length} recorded cleanup action(s)...`);
      const undone = replay(cleanup);
      cleanupPromoted = undone.promoted ?? [];
      const warning = cleanupReplayWarning(undone.dropped);
      if (warning !== null) log.warn(warning);
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
  const verdict = judgeReplayedRoute(dropped, {
    caseId: input.ref.id,
    makesSomething,
    hasCleanup: cleanup.length > 0,
  });
  if (verdict.refusal !== null) return verdict.refusal;
  for (const warning of verdict.warnings) log.warn(warning);
  log.meta("replay", "route still holds");
  return null;
}

/**
 * The drops that are evidence the route has moved.
 *
 * Two kinds are not. An action skipped in the wake of one that failed was
 * never attempted, so it says nothing. An action the recording already marked
 * `replayUnstable` failed its own post-trace validation too — codegen keeps it
 * for the warning it emits, not as a check, and a route is not dead because a
 * part already known to be unreliable still is. Discounted here, at judgment,
 * rather than dropped from the replay: the mark says the action is unreliable,
 * never that it has no effect, and the actions after it were recorded against
 * a page it may well have changed.
 */
const ALREADY_UNSTABLE_REASON = "the recording already marked them unstable, or they follow one it did";

function realFailures(dropped: readonly ValidationDrop[]): ValidationDrop[] {
  return dropped.filter(
    (d) => !isCascadeReason(d.reason) && d.action.replayUnstable !== true,
  );
}

/**
 * What the gate does with a replay's drops, decided apart from the browser.
 *
 * The two arms are exclusive by construction: a refused route has a reason and
 * nothing else to say, and only a route that passes carries notes.
 */
export type RouteReplayVerdict =
  | { refusal: string }
  | { refusal: null; warnings: string[] };

export interface RouteReplayContext {
  /** The case to name in the re-record instruction. */
  caseId: string;
  /** Whether the route names what it creates after this run, and so just created one. */
  makesSomething: boolean;
  /** Whether the case records an undo. */
  hasCleanup: boolean;
}

/** Read a strict replay's drops as a verdict on the route. */
export function judgeReplayedRoute(
  dropped: readonly ValidationDrop[],
  ctx: RouteReplayContext,
): RouteReplayVerdict {
  const failed = realFailures(dropped);
  if (failed.length > 0) {
    // One action failing takes the rest of its step with it, so the count
    // alone reads as a route that broke everywhere. What a reader needs first
    // is the action that actually failed; the rest is the size of its wake.
    // Discounted drops are left out of both: the recording already reports
    // them, and repeating that here buries the failure being refused over.
    const notReplayed = dropped.filter((d) => isCascadeReason(d.reason)).length;
    return {
      refusal:
        `the recorded route no longer replays. The first action that failed is ` +
        `${describeStepAction(failed[0]!.action)}` +
        (notReplayed > 0 ? `, and ${notReplayed} later action(s) were not replayed at all` : "") +
        `:\n${dropList(failed)}\n` +
        (ctx.makesSomething && ctx.hasCleanup
          ? `The recorded cleanup was not attempted — check the application for anything this left behind.\n`
          : "") +
        `Re-record with 'ccqa record ${ctx.caseId}'. Pass --no-replay to regenerate from the ` +
        `saved route anyway (e.g. with no browser or no variables in this environment).`,
    };
  }
  const warnings: string[] = [];
  if (ctx.makesSomething && !ctx.hasCleanup) {
    warnings.push(
      "this case records no cleanup, so what the check just created is still in the application",
    );
  } else if (ctx.makesSomething && dropped.length > 0) {
    // The undo is attempted only after a route that replayed whole, so a route
    // held up by the discount never reaches it. The verdict passes and the
    // data stays — which reads as a clean run unless this says otherwise.
    warnings.push(
      "the recorded cleanup was not attempted — the route did not replay whole, so what the " +
        "check just created is still in the application",
    );
  }
  // Said rather than passed over in silence: a route held up entirely by the
  // discount is one where nothing was checked, and that reads as a pass.
  if (dropped.length > 0) {
    warnings.push(
      `${dropped.length} action(s) did not replay and none is counted against the route — ` +
        `${ALREADY_UNSTABLE_REASON}:\n${dropList(dropped)}`,
    );
  }
  return { refusal: null, warnings };
}

/**
 * What to say about a cleanup that did not fully replay. A skipped or
 * already-unstable action is not evidence the undo broke, so only one the
 * replay ran and that failed can name what the check may not have undone.
 */
export function cleanupReplayWarning(dropped: readonly ValidationDrop[]): string | null {
  if (dropped.length === 0) return null;
  const failed = realFailures(dropped);
  if (failed.length === 0) {
    return `${dropped.length} recorded cleanup action(s) did not replay — ${ALREADY_UNSTABLE_REASON}`;
  }
  return (
    `the recorded cleanup did not fully replay (${failed.length} action(s)) — this check may ` +
    `have left ${describeStepAction(failed[0]!.action)} behind`
  );
}

/** One drop per line, capped so a long list stays readable. */
function dropList(drops: readonly ValidationDrop[]): string {
  return drops
    .slice(0, 5)
    .map((d) => `  - ${describeStepAction(d.action)} — ${d.reason}`)
    .join("\n");
}
