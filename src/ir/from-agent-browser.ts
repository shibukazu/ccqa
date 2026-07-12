import type { AssertType, Locator, LocatorIndex, RecordedAction } from "./types.ts";

/**
 * Normalization from the agent-browser side of the recorder into the IR.
 * The trace protocol emits one pipe-delimited `AB_ACTION|...` line per
 * browser action (see `src/prompts/trace.ts` and
 * `claude/invoke.ts:extractAbActionFromBashCommand`); `parseAbActionLine`
 * turns each line into a `RecordedAction`.
 *
 * The mapping is a deterministic re-encoding: `to-agent-browser.ts` is its
 * inverse, and the round-trip identity (ab argv → wire → IR → ab argv) is
 * pinned by `roundtrip.test.ts`.
 */

/**
 * Semantic locator strategies exposed by `agent-browser find`. Used by the
 * `find_*` wire commands when a target cannot be uniquely picked out by the
 * ALLOWED CSS forms (e.g. repeated `aria-label='1 reply'` rows where only
 * "the last one" is meaningful).
 *
 * `first` / `last` / `nth` are positional helpers whose value carries an
 * inner CSS selector (`nth` additionally needs an index); they normalize to
 * a `css` Locator plus `index`. The remaining strategies read the value as
 * the human-visible text/id and normalize to the matching `Locator.by`.
 */
export const FIND_LOCATORS = [
  "role", "text", "label", "placeholder", "alt", "title", "testid",
  "first", "last", "nth",
] as const;
export type FindLocator = (typeof FIND_LOCATORS)[number];

/**
 * Actions reachable via `agent-browser find <locator> ... <action>`. Kept
 * here next to the locator list so all `find` wire knowledge lives in one
 * place — `claude/invoke.ts` imports these instead of redefining its own sets.
 */
export const FIND_ACTIONS = [
  "click", "dblclick", "fill", "type", "hover", "focus", "check", "uncheck",
] as const;
export type FindAction = (typeof FIND_ACTIONS)[number];

const css = (value: string): Locator => ({ by: "css", value });

export function parseAbActionLine(line: string): RecordedAction | null {
  if (!line.startsWith("AB_ACTION|")) return null;
  const parts = line.split("|");
  const command = parts[1];

  switch (command) {
    case "cookies_clear":
      return { action: "cookies_clear" };
    case "open": {
      // Strip stray surrounding quotes that can appear when agent-browser is
      // called with a quoted URL.
      const url = (parts[2] ?? "").replace(/^["']|["']$/g, "");
      return { action: "navigate", value: url };
    }
    case "press":
      return { action: "press", ...opt("value", parts[2]) };
    case "scroll":
      return { action: "scroll", ...opt("direction", parts[2]), ...opt("pixels", parts[3]) };
    case "snapshot":
      return { action: "snapshot", ...opt("observation", parts[2]) };
    case "assert":
      return {
        action: "assert",
        assert: parts[2] as AssertType,
        ...(parts[3] ? { locator: css(parts[3]) } : {}),
        ...(parts[4] ? { value: parts[4] } : {}),
        ...(parts[5] ? { observation: parts[5] } : {}),
      };
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover": {
      if (!parts[2]) return null;
      return { action: command, locator: css(parts[2]), ...opt("label", parts[3]) };
    }
    case "wait": {
      // `wait --text <t>` is the canonical text wait; a raw `text=<t>`
      // selector string stays a css Locator (both replay identically).
      if (parts[2] === "--text") {
        if (!parts[3]) return null;
        return { action: "wait", locator: { by: "text", value: parts[3] }, ...opt("label", parts[4]) };
      }
      if (!parts[2]) return null;
      return { action: "wait", locator: css(parts[2]), ...opt("label", parts[3]) };
    }
    case "fill":
    case "type":
    case "select": {
      if (!parts[2]) return null;
      return {
        action: command,
        locator: css(parts[2]),
        ...(parts[3] !== undefined ? { value: parts[3] } : {}),
        ...opt("label", parts[4]),
      };
    }
    case "drag": {
      if (!parts[2] || !parts[3]) return null;
      return { action: "drag", locator: css(parts[2]), target: css(parts[3]), ...opt("label", parts[4]) };
    }
    case "upload": {
      // AB_ACTION|upload|<sel>|<file1>[|<file2>...]
      const selector = parts[2];
      const files = parts.slice(3).filter((f) => f !== "");
      if (!selector || files.length === 0) return null;
      return { action: "upload", locator: css(selector), files };
    }
    case "find_click":
    case "find_dblclick":
    case "find_hover":
    case "find_focus":
    case "find_check":
    case "find_uncheck":
      // AB_ACTION|find_<action>|<locator>|<value>|<extra>|<exact>|<label>
      return parseFindAction(command.slice("find_".length) as RecordedAction["action"], parts, false);
    case "find_fill":
    case "find_type":
      // AB_ACTION|find_<action>|<locator>|<value>|<extra>|<exact>|<fillValue>|<label>
      return parseFindAction(command.slice("find_".length) as RecordedAction["action"], parts, true);
    case "get_count":
    case "get_url":
      // Observation-only probes, surfaced by the hook layer purely so a
      // CCQA_ASSERT marker can promote them (see `promoteMarkedAssert`);
      // they never record as standalone actions.
      return null;
    default:
      return null;
  }
}

/**
 * Promote a `CCQA_ASSERT=<marker>` env marker on an agent-browser command
 * into recorded assert action(s). The marker travels on the same channel as
 * the command itself (see `claude/invoke.ts`), so a verification the model
 * performs anyway (`wait --text`, `get count`) becomes a recorded assert
 * without relying on the `AB_ACTION|assert|...` text protocol.
 *
 * `abAction` is the wire line for the marked command (null when the command
 * has no wire form at all). Mapping — anything else returns null and the
 * caller warns and records the command unpromoted:
 *
 * - `wait --text "X"` + `1` (or `text_visible`) → `assert text_visible X`,
 *   REPLACING the wait: the emitted abAssert is itself a timed wait, so
 *   keeping both would wait twice.
 * - `get count "<sel>"` + `element_visible` / `element_not_visible`
 *   → `assert <marker> <sel>` (the probe records nothing by itself).
 * - any command + `url_contains:<substring>` → the command's own action (if
 *   it records one) followed by `assert url_contains <substring>`.
 */
export function promoteMarkedAssert(
  abAction: string | null,
  marker: string,
): RecordedAction[] | null {
  if (marker.startsWith("url_contains:")) {
    const substring = marker.slice("url_contains:".length);
    if (!substring) return null;
    const assert: RecordedAction = { action: "assert", assert: "url_contains", value: substring };
    const base = abAction === null ? null : parseAbActionLine(abAction);
    return base === null ? [assert] : [base, assert];
  }
  const parts = abAction === null ? [] : abAction.split("|");
  if (marker === "1" || marker === "text_visible") {
    if (parts[1] === "wait" && parts[2] === "--text" && parts[3]) {
      return [{ action: "assert", assert: "text_visible", value: parts[3] }];
    }
    return null;
  }
  if (marker === "element_visible" || marker === "element_not_visible") {
    if (parts[1] === "get_count" && parts[2]) {
      return [{ action: "assert", assert: marker, locator: css(parts[2]) }];
    }
    return null;
  }
  return null;
}

/**
 * Common parser for the `find_*` wire family. `<extra>` carries `--name` for
 * `role`, the integer index for `nth`, and is empty otherwise. We accept a
 * literally empty `<extra>` (the LLM emits a placeholder `|` so the
 * positional layout stays stable across locators).
 */
function parseFindAction(
  action: RecordedAction["action"],
  parts: string[],
  hasFillValue: boolean,
): RecordedAction | null {
  const locatorToken = parts[2] as FindLocator | undefined;
  const findValue = parts[3];
  const extra = parts[4] ?? "";
  const exact = (parts[5] ?? "") === "exact";
  if (!locatorToken || !FIND_LOCATORS.includes(locatorToken) || !findValue) return null;

  let locator: Locator;
  let index: LocatorIndex | undefined;
  if (locatorToken === "first" || locatorToken === "last") {
    locator = css(findValue);
    index = locatorToken;
  } else if (locatorToken === "nth") {
    const parsed = extra ? Number.parseInt(extra, 10) : Number.NaN;
    if (Number.isNaN(parsed)) return null;
    locator = css(findValue);
    index = parsed;
  } else if (locatorToken === "role") {
    locator = {
      by: "role",
      value: findValue,
      ...(extra ? { name: extra } : {}),
      ...(exact ? { exact: true } : {}),
    };
  } else {
    locator = { by: locatorToken, value: findValue, ...(exact ? { exact: true } : {}) };
  }

  return {
    action,
    locator,
    ...(index !== undefined ? { index } : {}),
    ...(hasFillValue
      ? { ...(parts[6] !== undefined ? { value: parts[6] } : {}), ...opt("label", parts[7]) }
      : opt("label", parts[6])),
  };
}

/** Include an optional string field only when it is non-empty. */
function opt<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? ({ [key]: value } as { [P in K]?: string }) : {};
}
