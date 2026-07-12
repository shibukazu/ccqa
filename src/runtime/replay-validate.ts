import { spawnAB, sleepSync } from "./spawn-ab.ts";
import { resolveEnvRefs } from "./env-vars.ts";
import { locatorToSelector, toAgentBrowserArgs } from "../ir/to-agent-browser.ts";
import type { RecordedAction } from "../ir/types.ts";

/**
 * Some actions can't be validated by a single `agent-browser` argv because
 * `wait <css-selector>` ignores `--timeout` and blocks the daemon for ~150s
 * when the selector never matches (it then dies with EAGAIN, cascading into
 * everything after it). For element-existence checks we instead poll
 * `get count <selector>`, which returns in ~180ms whether the element exists
 * or not. `actionToAbArgs` returns this marker for those cases and the
 * replay loop runs the poll itself.
 */
export interface PollCheck {
  kind: "poll-present";
  selector: string;
  timeoutMs: number;
}

function isPollCheck(x: string[] | PollCheck | null): x is PollCheck {
  return x !== null && !Array.isArray(x) && (x as PollCheck).kind === "poll-present";
}

const SELECTOR_POLL_INTERVAL_MS = 500;

/** Poll `get count <selector>` until it matches (>=1) or the timeout elapses. */
function runPollCheck(check: PollCheck, sessionName: string): { ok: boolean; reason: string } {
  const deadline = Date.now() + check.timeoutMs;
  for (;;) {
    const r = spawnAB(["--session", sessionName, "get", "count", check.selector]);
    const count = r.status === 0 ? Number.parseInt(r.stdout.trim(), 10) : NaN;
    if (!Number.isNaN(count) && count > 0) return { ok: true, reason: "" };
    if (Date.now() >= deadline) {
      return { ok: false, reason: `selector not present within ${check.timeoutMs}ms (get count returned ${Number.isNaN(count) ? "error" : count})` };
    }
    sleepSync(SELECTOR_POLL_INTERVAL_MS);
  }
}

/**
 * Post-trace replay validation.
 *
 * After the Claude-driven trace finishes, we replay every recorded action
 * once against a fresh agent-browser session and DROP the ones that fail.
 * Claude's per-step verification (the MUST-VERIFY rule) catches most of the
 * obvious traps at record time, but it can't catch *coincidental* hits —
 * e.g. an `[aria-label='Submit']` selector that happened to match an
 * element from a sibling modal that was open during the trace and gone on
 * a fresh run. Replaying against a clean session surfaces those cases
 * cheaply and lets us strip them out before codegen.
 *
 * The validation is intentionally non-LLM: it just rolls through the
 * actions sequentially with the same EAGAIN-retry logic the production
 * test runtime uses. Any action that exits non-zero is dropped from the
 * returned list (and reported by the caller, which owns the logging).
 *
 * `snapshot` actions are kept as-is — they have no side effect at codegen
 * time (they only become a `// observation` comment) and there's no
 * value in re-verifying that the daemon can take a snapshot.
 */
export interface ValidationDrop {
  index: number;
  action: RecordedAction;
  reason: string;
}

export type ValidationMode =
  /**
   * Default: failures are reported as `unstable` and kept in ir.json
   * with a `replayUnstable: true` flag. Codegen emits a warning comment
   * but still writes the line, so the auto-fix loop (vitest run #1)
   * decides what to do at runtime.
   */
  | "lenient"
  /**
   * Legacy: failures are physically dropped from ir.json and the
   * generated test never sees them. Useful when the caller wants the
   * stricter "Claude said it passes, so the replay must too" semantics.
   */
  | "strict";

export interface ValidationResult {
  /** Actions that passed first-pass replay (or were rescued in pass 2). */
  kept: RecordedAction[];
  /**
   * Lenient mode: actions that failed replay but are still threaded through
   * to ir.json with `replayUnstable: true` set. Strict mode: always empty.
   */
  unstable: RecordedAction[];
  /**
   * Strict mode: actions removed from the output. Lenient mode: always empty.
   * Callers that previously relied on `dropped` for logging now also need to
   * inspect `unstable` (which carries the same `reason` via `replayReason`).
   */
  dropped: ValidationDrop[];
  /**
   * stepIds whose first-pass actions were all dropped but were restored
   * by the rescue pass (`rescueLostSteps`). Empty when no step needed
   * rescuing. Callers can surface this to the user to explain why the
   * action count "magically" grew on a second look.
   */
  rescuedSteps?: string[];
}

const SHORT_TIMEOUT_MS = 5_000;
const ASSERT_TIMEOUT_MS = 10_000;

/**
 * Convert one recorded action into the `agent-browser` arg list that would
 * exercise it. Interaction commands come from the shared
 * `ir/to-agent-browser.ts` mapping with env refs resolved; `wait` / `assert`
 * get validation-specific handling (poll checks, timeouts, unverifiable
 * skips). Returns `null` for actions that should not be validated (snapshot
 * has no side effect; assert types whose codegen forms aren't directly
 * verifiable here fall through to the caller's `unverifiable` fallback).
 */
export function actionToAbArgs(action: RecordedAction, sessionName: string): string[] | PollCheck | null {
  const base = ["--session", sessionName];

  // Resolve env refs in any value/selector positions so the validation
  // hits the same DOM the test will. Param refs (`$name`) without an env
  // match are preserved verbatim by `resolveEnvRefs`'s sibling
  // `substituteVars`; here we only care about env-based ones, which is
  // exactly what the generated script's template literals resolve too.
  const sub = (s: string | undefined): string => (s === undefined ? "" : resolveEnvRefs(s));

  switch (action.action) {
    case "snapshot":
      return null;
    case "assert":
      return assertToAbArgs(action, sub, sessionName);
    case "wait": {
      const loc = action.locator;
      if (!loc) return null; // selector omitted entirely — treat as unverifiable rather than failing the drop cascade.
      if (loc.by === "text") {
        return [...base, "wait", "--text", sub(loc.value), "--timeout", String(SHORT_TIMEOUT_MS)];
      }
      const raw = sub(locatorToSelector(loc));
      if (!raw) return null;
      if (/^\d+$/.test(raw)) return null; // numeric sleep — no-op in validation
      // Flag-form waits (`--load networkidle`, `--fn "..."`, `--url "..."`)
      // are readiness/observation conditions, not element-existence checks.
      // They're timing-dependent and not meaningful to re-verify on a fresh
      // session, so treat them as unverifiable (skip).
      if (raw.startsWith("--")) return null;
      if (raw.startsWith("text=")) {
        return [...base, "wait", "--text", raw.slice(5), "--timeout", String(SHORT_TIMEOUT_MS)];
      }
      // `wait <css-selector>` ignores --timeout and blocks the daemon; poll instead.
      return { kind: "poll-present", selector: raw, timeoutMs: SHORT_TIMEOUT_MS };
    }
    default: {
      const tokens = toAgentBrowserArgs(action);
      if (tokens === null) return null;
      return [...base, ...tokens.map((t) => sub(t.text))];
    }
  }
}

function assertToAbArgs(
  action: RecordedAction,
  sub: (s: string | undefined) => string,
  sessionName: string,
): string[] | PollCheck | null {
  const base = ["--session", sessionName];
  const val = sub(action.value ?? action.observation);
  const sel = sub(
    action.locator ? locatorToSelector(action.locator) : action.observation,
  );
  switch (action.assert) {
    case "text_visible":
      if (!val) return null;
      return [...base, "wait", "--text", val, "--timeout", String(ASSERT_TIMEOUT_MS)];
    case "text_not_visible":
      // Skipping at validation time: a freshly-opened replay session has the
      // text initially absent, so the assertion is vacuously true here even
      // when the production run would correctly observe its disappearance
      // after a click. Trust the codegen output for this case.
      return null;
    case "element_visible":
      if (!sel) return null;
      // `wait <css-selector>` ignores --timeout and blocks; poll instead.
      return { kind: "poll-present", selector: sel, timeoutMs: ASSERT_TIMEOUT_MS };
    case "element_not_visible":
      // Same vacuous-truth concern as text_not_visible.
      return null;
    case "url_contains":
      // Checked by reading the URL, not by a wait; trust codegen.
      return null;
    case "element_enabled":
    case "element_disabled":
    case "element_checked":
    case "element_unchecked":
      // `is enabled/checked` are state probes — re-running them on a fresh
      // session before the prior actions have built up the right page state
      // is meaningless. The replay loop runs the *whole* action list in
      // order, so by the time we hit one of these, the page is in the
      // right state. Validate the selector exists at all via a presence poll.
      if (!sel || sel.startsWith("text=") || sel.startsWith("[aria-label=")) return null;
      return { kind: "poll-present", selector: sel, timeoutMs: ASSERT_TIMEOUT_MS };
    default:
      return null;
  }
}

export interface ValidateOptions {
  sessionName: string;
  /**
   * `"lenient"` (default): failing actions land in `unstable` and are tagged
   * with `replayUnstable: true` so they still reach codegen. `"strict"`:
   * failing actions are dropped from the output entirely (pre-v0.5 behaviour).
   */
  mode?: ValidationMode;
  /**
   * Optional progress callback fired once per action just before its
   * agent-browser invocation. `index` is 0-based; `total` is the full
   * count including actions that may end up skipped. Callers use this to
   * render a live progress line so a slow validation pass doesn't look
   * like a hang.
   */
  onProgress?: (index: number, total: number, action: RecordedAction) => void;
}

// Sentinel for actions that carry no stepId (older traces, or commands
// emitted before STEP_START). Step-scoped skip falls back to "rest of the
// trace" for these — i.e. the v0.4 behaviour. We don't conflate the
// sentinel with any real stepId because real ids look like "step-NN".
const NO_STEP_ID = "__no_step__";

interface ActionOutcome {
  /** True when the action is unverifiable (no side effect to replay). */
  skipped: boolean;
  /** True when the action replayed successfully. */
  ok: boolean;
  /** Failure reason (only meaningful when ok === false && skipped === false). */
  reason: string;
}

/**
 * Replay one recorded action against the validation session. Element-presence
 * checks go through `runPollCheck` (which uses `get count`, never the blocking
 * `wait <selector>`); everything else spawns the agent-browser argv. A single
 * hard-timeout (SIGTERM) retry covers the daemon's occasional under-load drop.
 */
function runValidationAction(action: RecordedAction, sessionName: string): ActionOutcome {
  const built = actionToAbArgs(action, sessionName);
  if (built === null) return { skipped: true, ok: false, reason: "" };
  if (isPollCheck(built)) {
    const { ok, reason } = runPollCheck(built, sessionName);
    return { skipped: false, ok, reason };
  }
  let result = spawnAB(built);
  if (result.status !== 0 && looksLikeHardTimeout(result)) {
    // Hard-timeout retry, capped at 1: agent-browser's daemon occasionally
    // drops a request under load. One extra attempt is cheaper than re-tracing.
    result = spawnAB(built);
  }
  if (result.status === 0) return { skipped: false, ok: true, reason: "" };
  return {
    skipped: false,
    ok: false,
    reason: (result.stderr.trim() || result.stdout.trim() || `agent-browser exit ${result.status ?? "?"}`).slice(0, 200),
  };
}

export function validateActions(
  actions: RecordedAction[],
  opts: ValidateOptions,
): ValidationResult {
  const kept: RecordedAction[] = [];
  const dropped: ValidationDrop[] = [];

  // Cascade design:
  //   - A failed *state-mutating* action (click/fill/navigate/…) poisons
  //     the rest of the page state, so any passive action (wait / assert /
  //     snapshot) that follows can't be replayed meaningfully — drop them
  //     as collateral, but ONLY until the next step boundary. v0.4 used
  //     "until the next side-effecting command", which let one bad action
  //     poison the entire trace.
  //   - A failed *passive* action (assert/wait/snapshot) does NOT mutate
  //     state. Drop the offender itself, but let the next passive try —
  //     it might be observing something orthogonal.
  //   - SIGTERM from agent-browser is treated as a transient daemon
  //     hiccup: retry once before counting it as a failure.
  let skipFromStepId: string | null = null;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    opts.onProgress?.(i, actions.length, action);
    const stepId = action.stepId ?? NO_STEP_ID;
    // Crossing a step boundary clears the skip — each step's expected
    // page state is described independently in the spec.
    if (skipFromStepId !== null && skipFromStepId !== stepId) {
      skipFromStepId = null;
    }
    if (skipFromStepId !== null && isPassiveAction(action.action)) {
      dropped.push({ index: i, action, reason: "skipped after a preceding action failed" });
      continue;
    }
    const outcome = runValidationAction(action, opts.sessionName);
    if (outcome.skipped) {
      kept.push(action);
      continue;
    }
    if (outcome.ok) {
      kept.push(action);
      // A successful state-mutating action means the page is now in a
      // known-good state — let subsequent passives observe it.
      if (skipFromStepId !== null && !isPassiveAction(action.action)) {
        skipFromStepId = null;
      }
      continue;
    }
    dropped.push({ index: i, action, reason: outcome.reason });
    if (!isPassiveAction(action.action)) {
      // Only state-mutating failures poison subsequent actions.
      skipFromStepId = stepId;
    }
  }
  const afterRescue = rescueLostSteps(actions, kept, dropped, opts);
  return splitByMode(actions, afterRescue, opts.mode ?? "lenient");
}

/**
 * Translate the internal `{ kept, dropped }` result of the rescue pass
 * into the public-facing shape. In strict mode the caller sees the same
 * shape as before (kept/dropped); in lenient mode the still-failed
 * actions move to `unstable` with `replayUnstable: true` tagged on, so
 * codegen can warn about them while still emitting the line.
 */
function splitByMode(
  originalActions: RecordedAction[],
  result: { kept: RecordedAction[]; dropped: ValidationDrop[]; rescuedSteps?: string[] },
  mode: ValidationMode,
): ValidationResult {
  if (mode === "strict") {
    return { kept: result.kept, unstable: [], dropped: result.dropped, rescuedSteps: result.rescuedSteps };
  }
  const droppedByIndex = new Map(result.dropped.map((d) => [d.index, d]));
  const keptSet = new Set(result.kept);
  const finalKept: RecordedAction[] = [];
  const unstable: RecordedAction[] = [];
  for (let i = 0; i < originalActions.length; i++) {
    const action = originalActions[i]!;
    if (keptSet.has(action)) {
      finalKept.push(action);
      continue;
    }
    const drop = droppedByIndex.get(i);
    if (drop) {
      // Mark in place so the action retains the flag once it lands in
      // ir.json. We don't deep-clone — every consumer downstream
      // reads through the same reference and benefits from the tag.
      action.replayUnstable = true;
      action.replayReason = drop.reason;
      unstable.push(action);
    }
  }
  return { kept: finalKept, unstable, dropped: [], rescuedSteps: result.rescuedSteps };
}

/**
 * Last-line-of-defence pass that preserves whole spec steps from disappearing.
 *
 * After the main validation loop, walk the dropped list and identify steps
 * whose every action was dropped. For each lost step, replay its dropped
 * actions one more time in isolation — no cascade, no shared bookkeeping.
 * Any action that finally returns exit 0 gets promoted back into `kept`.
 *
 * Why bother: when cascade collapses a step, the post-trace report flags it,
 * but the generated test still loses the step's intent. A second pass that
 * costs N extra agent-browser invocations (where N is small, since lost
 * steps are rare) is cheap insurance against silently shipping a half-tested
 * spec.
 *
 * The rescue is deliberately narrow:
 *   - Only steps that lost EVERY action are eligible — partial losses are
 *     left as-is, since the surviving action represents the step's intent.
 *   - Each rescued action is replayed exactly once. We do NOT recurse, do
 *     NOT re-cascade, do NOT retry on hard timeout — keep behaviour
 *     predictable.
 *   - Steps without a stepId (`NO_STEP_ID`) are skipped — they share the
 *     v0.4 "rest of trace" semantics and rescuing them would over-fire.
 */
interface RescuePassResult {
  kept: RecordedAction[];
  dropped: ValidationDrop[];
  rescuedSteps?: string[];
}

function rescueLostSteps(
  actions: RecordedAction[],
  kept: RecordedAction[],
  dropped: ValidationDrop[],
  opts: ValidateOptions,
): RescuePassResult {
  // Build a quick "which steps kept anything" set.
  const stepsWithSurvivors = new Set<string>();
  for (const a of kept) {
    if (a.stepId) stepsWithSurvivors.add(a.stepId);
  }
  // Group drops by stepId and find the ones we can rescue.
  const lostStepDrops = new Map<string, ValidationDrop[]>();
  for (const d of dropped) {
    const id = d.action.stepId;
    if (!id || stepsWithSurvivors.has(id)) continue;
    const list = lostStepDrops.get(id) ?? [];
    list.push(d);
    lostStepDrops.set(id, list);
  }
  if (lostStepDrops.size === 0) return { kept, dropped };

  const rescuedIndices = new Set<number>();
  const rescuedSteps: string[] = [];
  for (const [stepId, drops] of lostStepDrops.entries()) {
    let anyForThisStep = false;
    for (const d of drops) {
      const outcome = runValidationAction(d.action, opts.sessionName);
      if (outcome.skipped) continue;
      if (outcome.ok) {
        rescuedIndices.add(d.index);
        anyForThisStep = true;
      }
    }
    if (anyForThisStep) rescuedSteps.push(stepId);
  }
  if (rescuedIndices.size === 0) return { kept, dropped };

  // Re-thread kept in original action order so rescued actions land at
  // their correct index and downstream consumers see a stable sequence.
  // `kept.includes(...)` uses object identity, which is fine because the
  // validator pushes original references — no shallow copies.
  const keptSet = new Set(kept);
  const newKept: RecordedAction[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    if (rescuedIndices.has(i) || keptSet.has(action)) newKept.push(action);
  }
  const newDropped = dropped.filter((d) => !rescuedIndices.has(d.index));
  return { kept: newKept, dropped: newDropped, rescuedSteps };
}

/** Did this agent-browser invocation get SIGTERM'd by the ccqa hard-timeout watchdog? */
function looksLikeHardTimeout(result: { stderr: string }): boolean {
  return result.stderr.includes("agent-browser killed after hard timeout");
}

/**
 * Passive (read-only) actions whose only effect is observation. When a
 * preceding action fails, dropping these too is the right move because
 * they were trying to observe state the failed action would have set up.
 */
function isPassiveAction(action: RecordedAction["action"]): boolean {
  return action === "snapshot" || action === "wait" || action === "assert";
}
