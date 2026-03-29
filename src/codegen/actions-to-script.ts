import type { TraceAction } from "../types.ts";

/**
 * Converts recorded trace actions into a vitest-compatible test.spec.ts.
 * Uses child_process.spawnSync with explicit argument arrays to avoid shell quoting issues.
 * agent-browser bin is resolved via import.meta.resolve to avoid hardcoded absolute paths.
 */
export function actionsToScript(actions: TraceAction[]): string {
  const testLines: string[] = [];

  // Deduplicate consecutive identical lines (same command + same args)
  let prevLine: string | null = null;
  for (const action of actions) {
    const line = actionToLine(action);
    if (line === null) continue;
    if (line === prevLine) continue;
    testLines.push(line);
    prevLine = line;
  }

  const body = testLines.map((l) => `  ${l}`).join("\n");

  // Resolve the helpers path relative to this file so it works from any cwd
  const helpersPath = new URL("../runtime/test-helpers.ts", import.meta.url).pathname;

  return [
    `import { test } from "vitest";`,
    `import { spawnSync } from "node:child_process";`,
    `import { ab, abWait, abAssertTextVisible, abAssertVisible, abAssertNotVisible, abAssertUrl, abAssertEnabled, abAssertDisabled, abAssertChecked, abAssertUnchecked } from ${JSON.stringify(helpersPath)};`,
    "",
    `test("full flow", () => {`,
    body,
    "}, 5 * 60 * 1000);",
    "",
  ].join("\n");
}

/** Returns true if a selector is a session-specific @ref that cannot be replayed. */
function isRefSelector(selector: string | undefined): boolean {
  return typeof selector === "string" && /^@/.test(selector.trim());
}

function actionToLine(action: TraceAction): string | null {
  // Skip actions that use @ref selectors — they are session-specific and not replayable
  if ("selector" in action && isRefSelector(action.selector)) return null;

  switch (action.command) {
    case "cookies_clear":
      return `ab("cookies", "clear");`;

    case "open": {
      // Strip stray surrounding quotes that can appear when agent-browser is called with quoted URL
      const url = (action.value ?? "").replace(/^["']|["']$/g, "");
      return `ab("open", ${j(url)});`;
    }

    case "snapshot":
      return action.observation ? `// ${action.observation}` : null;

    case "click":
      return `ab("click", ${j(action.selector!)});`;

    case "dblclick":
      return `ab("dblclick", ${j(action.selector!)});`;

    case "fill":
      return `ab("fill", ${j(action.selector!)}, ${j(action.value!)});`;

    case "type":
      return `ab("fill", ${j(action.selector!)}, ${j(action.value!)});`;

    case "check":
      return `ab("check", ${j(action.selector!)});`;

    case "uncheck":
      return `ab("uncheck", ${j(action.selector!)});`;

    case "press":
      return `ab("press", ${j(action.value!)});`;

    case "select":
      return `ab("select", ${j(action.selector!)}, ${j(action.value!)});`;

    case "hover":
      return `ab("hover", ${j(action.selector!)});`;

    case "scroll": {
      const args = [action.direction ?? "down", ...(action.pixels ? [action.pixels] : [])];
      return `ab("scroll", ${args.map(j).join(", ")});`;
    }

    case "drag":
      return `ab("drag", ${j(action.selector!)}, ${j(action.target!)});`;

    case "wait": {
      const sel = action.selector!;
      // Numeric waits are not a valid agent-browser command — skip them
      if (/^\d+$/.test(sel)) return null;
      return `abWait(${j(sel)});`;
    }

    case "assert": {
      // LLM may omit selector/value fields and put the text in observation instead
      // Fall back to observation when the specific field is missing
      const val = action.value ?? action.observation;
      const sel = action.selector ?? action.observation;
      const comment = action.observation ? `// Assert: ${action.observation}` : null;
      let assertLine: string | null = null;
      switch (action.assertType) {
        case "text_visible":
          if (val) assertLine = `abAssertTextVisible(${j(val)});`;
          break;
        case "text_not_visible":
          if (val) assertLine = `abAssertNotVisible(${j("text=" + val)});`;
          break;
        case "element_visible":
          if (sel) assertLine = `abAssertVisible(${j(sel)});`;
          break;
        case "element_not_visible":
          if (sel) assertLine = `abAssertNotVisible(${j(sel)});`;
          break;
        case "url_contains":
          if (val) assertLine = `abAssertUrl(${j(val)});`;
          break;
        case "element_enabled":
          if (sel) assertLine = `abAssertEnabled(${j(sel)});`;
          break;
        case "element_disabled":
          if (sel) assertLine = `abAssertDisabled(${j(sel)});`;
          break;
        case "element_checked":
          if (sel) assertLine = `abAssertChecked(${j(sel)});`;
          break;
        case "element_unchecked":
          if (sel) assertLine = `abAssertUnchecked(${j(sel)});`;
          break;
      }
      if (comment && assertLine) return `${comment}\n  ${assertLine}`;
      return assertLine ?? comment;
    }

    default:
      return null;
  }
}

/** JSON.stringify — produces a quoted string literal safe for embedding in TS source. */
const j = (s: string) => JSON.stringify(s);
