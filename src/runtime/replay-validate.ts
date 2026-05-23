import { spawnAB } from "./spawn-ab.ts";
import { resolveEnvRefs } from "./env-vars.ts";
import type { TraceAction, TraceCommand } from "../types.ts";

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
 * commands sequentially with the same EAGAIN-retry logic the production
 * test runtime uses. Any action that exits non-zero is dropped from the
 * returned list (and reported by the caller, which owns the logging).
 *
 * `snapshot` actions are kept as-is — they have no side effect at codegen
 * time (they only become a `// observation` comment) and there's no
 * value in re-verifying that the daemon can take a snapshot.
 */
export interface ValidationDrop {
  index: number;
  action: TraceAction;
  reason: string;
}

export interface ValidationResult {
  kept: TraceAction[];
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
 * exercise it. Returns `null` for actions that should not be validated
 * (snapshot has no side effect; assert types whose codegen forms aren't
 * directly verifiable here fall through to the caller's `unverifiable`
 * fallback).
 */
export function actionToAbArgs(action: TraceAction, sessionName: string): string[] | null {
  const base = ["--session", sessionName];

  // Resolve env refs in any value/selector positions so the validation
  // hits the same DOM the test will. Param refs (`$name`) without an env
  // match are preserved verbatim by `resolveEnvRefs`'s sibling
  // `substituteVars`; here we only care about env-based ones, which is
  // exactly what the generated script's template literals resolve too.
  const sub = (s: string | undefined): string => (s === undefined ? "" : resolveEnvRefs(s));

  switch (action.command) {
    case "cookies_clear":
      return [...base, "cookies", "clear"];
    case "open":
      return [...base, "open", sub(action.value).replace(/^["']|["']$/g, "")];
    case "click":
      return [...base, "click", sub(action.selector)];
    case "dblclick":
      return [...base, "dblclick", sub(action.selector)];
    case "fill":
    case "type":
      return [...base, "fill", sub(action.selector), sub(action.value)];
    case "check":
      return [...base, "check", sub(action.selector)];
    case "uncheck":
      return [...base, "uncheck", sub(action.selector)];
    case "press":
      return [...base, "press", sub(action.value)];
    case "select":
      return [...base, "select", sub(action.selector), sub(action.value)];
    case "hover":
      return [...base, "hover", sub(action.selector)];
    case "scroll": {
      const args = [action.direction ?? "down", ...(action.pixels ? [action.pixels] : [])];
      return [...base, "scroll", ...args];
    }
    case "drag":
      return [...base, "drag", sub(action.selector), sub(action.target)];
    case "wait": {
      const raw = sub(action.selector);
      if (!raw) return null; // selector omitted entirely — treat as unverifiable rather than failing the drop cascade.
      if (/^\d+$/.test(raw)) return null; // numeric sleep — no-op in validation
      if (raw.startsWith("text=")) {
        return [...base, "wait", "--text", raw.slice(5), "--timeout", String(SHORT_TIMEOUT_MS)];
      }
      return [...base, "wait", raw, "--timeout", String(SHORT_TIMEOUT_MS)];
    }
    case "snapshot":
      return null;
    case "assert":
      return assertToAbArgs(action, sub, sessionName);
    case "find_click":
    case "find_dblclick":
    case "find_hover":
    case "find_focus":
    case "find_check":
    case "find_uncheck":
      return buildFindArgs(action, undefined, sub, base);
    case "find_fill":
    case "find_type":
      return buildFindArgs(action, sub(action.value), sub, base);
  }
}

/**
 * Build the agent-browser argv for a recorded `find_*` action. Mirrors the
 * codegen shape in `actions-to-script.ts:buildFindArgs` but emits a plain
 * string array. Env refs in `findValue` / `findName` resolve through `sub`
 * so the validator hits the same DOM the generated test will.
 */
function buildFindArgs(
  action: TraceAction,
  fillValue: string | undefined,
  sub: (s: string | undefined) => string,
  base: string[],
): string[] | null {
  const locator = action.findLocator;
  if (!locator || !action.findValue) return null;
  const innerAction = action.command.slice("find_".length).replace("type", "fill");
  const out = [...base, "find", locator];
  if (locator === "nth") out.push(String(action.findIndex ?? 0));
  out.push(sub(action.findValue));
  // agent-browser expects `<value> <action> [--name <n>] [--exact]` — flags
  // MUST follow the action token. Putting --name before it produced
  // "Unknown subaction: --name" on every find_role call we recorded.
  out.push(innerAction);
  if (fillValue !== undefined) out.push(fillValue);
  // `--name` is role-only — drop it on every other locator even if a stray
  // findName slipped into actions.json (agent-browser rejects it otherwise).
  if (locator === "role" && action.findName) {
    out.push("--name", sub(action.findName));
  }
  if (action.findExact) out.push("--exact");
  return out;
}

function assertToAbArgs(
  action: TraceAction,
  sub: (s: string | undefined) => string,
  sessionName: string,
): string[] | null {
  const base = ["--session", sessionName];
  const val = sub(action.value ?? action.observation);
  const sel = sub(action.selector ?? action.observation);
  switch (action.assertType) {
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
      return [...base, "wait", sel, "--timeout", String(ASSERT_TIMEOUT_MS)];
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
      // right state. Validate the selector exists at all via a wait first.
      if (!sel || sel.startsWith("text=") || sel.startsWith("[aria-label=")) return null;
      return [...base, "wait", sel, "--timeout", String(ASSERT_TIMEOUT_MS)];
    default:
      return null;
  }
}

export interface ValidateOptions {
  sessionName: string;
}

// Sentinel for actions that carry no stepId (older traces, or commands
// emitted before STEP_START). Step-scoped skip falls back to "rest of the
// trace" for these — i.e. the v0.4 behaviour. We don't conflate the
// sentinel with any real stepId because real ids look like "step-NN".
const NO_STEP_ID = "__no_step__";

export function validateActions(
  actions: TraceAction[],
  opts: ValidateOptions,
): ValidationResult {
  const kept: TraceAction[] = [];
  const dropped: ValidationDrop[] = [];

  // Cascade design:
  //   - A failed *state-mutating* action (click/fill/open/find_click/…)
  //     poisons the rest of the page state, so any passive action (wait /
  //     assert / snapshot) that follows can't be replayed meaningfully —
  //     drop them as collateral, but ONLY until the next step boundary.
  //     v0.4 used "until the next side-effecting command", which let one
  //     bad action poison the entire trace.
  //   - A failed *passive* action (assert/wait/snapshot) does NOT mutate
  //     state. Drop the offender itself, but let the next passive try —
  //     it might be observing something orthogonal.
  //   - SIGTERM from agent-browser is treated as a transient daemon
  //     hiccup: retry once before counting it as a failure.
  let skipFromStepId: string | null = null;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const stepId = action.stepId ?? NO_STEP_ID;
    // Crossing a step boundary clears the skip — each step's expected
    // page state is described independently in the spec.
    if (skipFromStepId !== null && skipFromStepId !== stepId) {
      skipFromStepId = null;
    }
    if (skipFromStepId !== null && isPassiveCommand(action.command)) {
      dropped.push({ index: i, action, reason: "skipped after a preceding action failed" });
      continue;
    }
    const args = actionToAbArgs(action, opts.sessionName);
    if (args === null) {
      kept.push(action);
      continue;
    }
    let result = spawnAB(args);
    if (result.status !== 0 && looksLikeHardTimeout(result)) {
      // Hard-timeout retry, capped at 1: agent-browser's daemon
      // occasionally drops a request under load. Burning a single extra
      // ~30s budget here is cheaper than re-tracing the whole spec.
      result = spawnAB(args);
    }
    if (result.status === 0) {
      kept.push(action);
      // A successful state-mutating action means the page is now in a
      // known-good state — let subsequent passives observe it.
      if (skipFromStepId !== null && !isPassiveCommand(action.command)) {
        skipFromStepId = null;
      }
      continue;
    }
    dropped.push({
      index: i,
      action,
      reason:
        (result.stderr.trim() || result.stdout.trim() || `agent-browser exit ${result.status ?? "?"}`).slice(0, 200),
    });
    if (!isPassiveCommand(action.command)) {
      // Only state-mutating failures poison subsequent actions.
      skipFromStepId = stepId;
    }
  }
  return rescueLostSteps(actions, kept, dropped, opts);
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
function rescueLostSteps(
  actions: TraceAction[],
  kept: TraceAction[],
  dropped: ValidationDrop[],
  opts: ValidateOptions,
): ValidationResult {
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
      const args = actionToAbArgs(d.action, opts.sessionName);
      if (args === null) continue;
      const result = spawnAB(args);
      if (result.status === 0) {
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
  const newKept: TraceAction[] = [];
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
 * Passive (read-only) commands whose only effect is observation. When a
 * preceding action fails, dropping these too is the right move because
 * they were trying to observe state the failed action would have set up.
 */
function isPassiveCommand(cmd: TraceCommand): boolean {
  return cmd === "snapshot" || cmd === "wait" || cmd === "assert";
}
