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
  }
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

export function validateActions(
  actions: TraceAction[],
  opts: ValidateOptions,
): ValidationResult {
  const kept: TraceAction[] = [];
  const dropped: ValidationDrop[] = [];
  // We keep going past a failure so a single bad action doesn't abort
  // validation of everything that follows — but skip subsequent actions
  // that *depend* on the failed one's side effect (mostly `wait` /
  // `assert` after a failed `click`). The simple rule: drop the failing
  // action and any contiguous run of selectorless waits / asserts that
  // immediately follow it, up to the next side-effecting command.
  let skipUntilSideEffect = false;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    if (skipUntilSideEffect && isPassiveCommand(action.command)) {
      dropped.push({ index: i, action, reason: "skipped after a preceding action failed" });
      continue;
    }
    skipUntilSideEffect = false;
    const args = actionToAbArgs(action, opts.sessionName);
    if (args === null) {
      kept.push(action);
      continue;
    }
    const result = spawnAB(args);
    if (result.status === 0) {
      kept.push(action);
      continue;
    }
    dropped.push({
      index: i,
      action,
      reason:
        (result.stderr.trim() || result.stdout.trim() || `agent-browser exit ${result.status ?? "?"}`).slice(0, 200),
    });
    skipUntilSideEffect = true;
  }
  return { kept, dropped };
}

/**
 * Passive (read-only) commands whose only effect is observation. When a
 * preceding action fails, dropping these too is the right move because
 * they were trying to observe state the failed action would have set up.
 */
function isPassiveCommand(cmd: TraceCommand): boolean {
  return cmd === "snapshot" || cmd === "wait" || cmd === "assert";
}
