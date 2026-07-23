import type { Locator, RecordedAction } from "./types.ts";

/**
 * The single IR → agent-browser argv mapping. Both consumers build on it so
 * the command assembly can never drift apart again:
 *
 *   - `codegen/actions-to-script.ts` renders the tokens into `ab(...)` calls
 *     in the generated test (env-expandable tokens become template literals);
 *   - `runtime/replay-validate.ts` resolves env refs and spawns the argv.
 *
 * `wait` / `assert` / `snapshot` have consumer-specific semantics (helper
 * calls vs validation probes vs comments) and are only partially covered:
 * `toAgentBrowserArgs` returns the canonical replay argv for `wait` and
 * `null` for `assert` / `snapshot`.
 */

export interface AbToken {
  text: string;
  /**
   * True for tokens carrying user-supplied values (fill text, URLs, find
   * texts, accessible names, file paths, and CSS/selector-engine strings)
   * whose `${VAR}` / `$VAR` refs must resolve at test run time. False for
   * command words and flags, which are always literal. A `$` in a selector
   * that doesn't form a well-formed ref (e.g. the `$=` "ends-with" operator)
   * is preserved verbatim by the renderer.
   */
  expandsEnv: boolean;
}

const lit = (text: string): AbToken => ({ text, expandsEnv: false });
const val = (text: string): AbToken => ({ text, expandsEnv: true });

/**
 * Render a locator as the selector string a plain agent-browser command
 * accepts. Only `css` (verbatim) and `text` (`text=` engine form) have a
 * plain-selector form; other strategies are reachable via `find` only and
 * fall back to their raw value (callers guard against that case).
 */
export function locatorToSelector(locator: Locator): string {
  return locator.by === "text" ? `text=${locator.value}` : locator.value;
}

/**
 * Compact human-readable locator form for logs and LLM-prompt summaries: the
 * raw selector for `css`, `by=value` otherwise. Distinct from
 * `locatorToSelector` (which produces a selector agent-browser can execute) —
 * this one is for display only and never round-trips.
 */
export function describeLocator(locator: Locator): string {
  return locator.by === "css" ? locator.value : `${locator.by}=${locator.value}`;
}

/**
 * Canonical agent-browser argv (sans `--session`) for one action. Returns
 * null for actions with no direct argv form: observation-only `snapshot`,
 * `assert` (validation probes / abAssert* helpers live in the consumers),
 * and structurally incomplete actions (e.g. a missing locator).
 */
export function toAgentBrowserArgs(action: RecordedAction): AbToken[] | null {
  switch (action.action) {
    case "cookies_clear":
      return [lit("cookies"), lit("clear")];
    case "navigate":
      return [lit("open"), val(action.value ?? "")];
    case "press":
      return [lit("press"), val(action.value ?? "")];
    case "scroll":
      return [lit("scroll"), lit(action.direction ?? "down"), ...(action.pixels ? [lit(action.pixels)] : [])];
    case "select": {
      if (!action.locator) return null;
      return [lit("select"), val(locatorToSelector(action.locator)), val(action.value ?? "")];
    }
    case "drag": {
      if (!action.locator || !action.target) return null;
      return [lit("drag"), val(locatorToSelector(action.locator)), val(locatorToSelector(action.target))];
    }
    case "upload": {
      const files = action.files ?? [];
      if (!action.locator || files.length === 0) return null;
      return [lit("upload"), val(locatorToSelector(action.locator)), ...files.map(val)];
    }
    case "wait": {
      const loc = action.locator;
      if (!loc) return null;
      if (loc.by === "text") return [lit("wait"), lit("--text"), val(loc.value)];
      return [lit("wait"), val(locatorToSelector(loc))];
    }
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
    case "focus":
    case "fill":
    case "type":
      return interactionToArgs(action);
    case "snapshot":
    case "assert":
      return null;
  }
}

/**
 * Element interactions come in two argv shapes: the plain command
 * (`click "<css>"`) when the locator is a raw selector string, and the
 * `find <locator> <value> <action> [input] [--name <n>] [--exact]` form for
 * semantic locators and positional (`index`) picks. `type` is a ccqa-side
 * alias of `fill` in both shapes. Flags MUST follow the action token —
 * putting them before it makes agent-browser fail with "Unknown subaction".
 */
function interactionToArgs(action: RecordedAction): AbToken[] | null {
  const loc = action.locator;
  if (!loc) return null;
  const abAction = action.action === "type" ? "fill" : action.action;
  const takesInput = action.action === "fill" || action.action === "type";

  // `focus` exists only under `find`, so it always takes the find form.
  const needsFind = loc.by !== "css" || action.index !== undefined || action.action === "focus";
  if (!needsFind) {
    const args = [lit(abAction), val(loc.value)];
    if (takesInput) args.push(val(action.value ?? ""));
    return args;
  }

  if (!loc.value) return null;
  const out = [lit("find")];
  if (action.index !== undefined) {
    // Positional pick: the locator must be a raw CSS selector (the inner
    // selector of `find first/last/nth`), rendered through the env-ref-aware
    // path so a `${VAR}` ref inside it resolves at run time.
    if (loc.by !== "css") return null;
    if (action.index === "first" || action.index === "last") {
      out.push(lit(action.index));
    } else {
      out.push(lit("nth"), lit(String(action.index)));
    }
    out.push(val(loc.value));
  } else {
    if (loc.by === "css") return null; // bare css has no find form
    out.push(lit(loc.by), val(loc.value));
  }
  out.push(lit(abAction));
  if (takesInput) out.push(val(action.value ?? ""));
  // `--name` is role-only — agent-browser rejects it on every other locator.
  if (loc.by === "role" && loc.name) out.push(lit("--name"), val(loc.name));
  if (loc.by !== "css" && loc.exact) out.push(lit("--exact"));
  return out;
}
