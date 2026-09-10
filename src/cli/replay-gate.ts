import { generateSessionName } from "../prompts/trace.ts";
import {
  assertAgentBrowserAvailable,
  AgentBrowserUnavailableError,
  formatAgentBrowserUnavailableMessage,
} from "../runtime/agent-browser-bin.ts";
import { closeSession } from "../diagnose/snapshot.ts";
import { validateActions, type ValidationDrop } from "../runtime/replay-validate.ts";
import { describeLocator } from "../ir/to-agent-browser.ts";
import { specKey, type SpecRef } from "../store/index.ts";
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
  ref: SpecRef;
  cwd: string;
  /** The saved route about to be recompiled. */
  recording: RecordedAction[];
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
  log.info(`replaying ${input.recording.length} recorded action(s) to check the route still holds...`);
  let dropped: ValidationDrop[];
  try {
    ({ dropped } = validateActions(input.recording, {
      sessionName,
      mode: "strict",
      onProgress: (i, total, action) => log.progress(i, total, action.action),
    }));
  } finally {
    log.progressEnd();
    void (input.teardown?.closeTracked(sessionName) ?? closeSession(sessionName));
  }
  if (dropped.length === 0) {
    log.meta("replay", "route still holds");
    return null;
  }
  const failures = dropped
    .slice(0, 5)
    .map((d) => `  - ${d.action.action}${d.action.locator ? ` ${describeLocator(d.action.locator)}` : ""} — ${d.reason}`)
    .join("\n");
  return (
    `the recorded route no longer replays (${dropped.length} of ${input.recording.length} action(s) failed):\n` +
    `${failures}\n` +
    `Re-record with 'ccqa record ${specKey(input.ref)}'. Pass --no-replay to regenerate from the ` +
    `saved route anyway (e.g. with no browser or no variables in this environment).`
  );
}
