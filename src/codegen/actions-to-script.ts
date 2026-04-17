import type { TraceAction } from "../types.ts";

/**
 * Converts recorded trace actions into a vitest-compatible test.spec.ts.
 * Uses child_process.spawnSync with explicit argument arrays to avoid shell quoting issues.
 * agent-browser bin is resolved via import.meta.resolve to avoid hardcoded absolute paths.
 */
export interface SetupScript {
  name: string;
  body: string;
}

export function actionsToScript(actions: TraceAction[], title: string, setupScripts?: SetupScript[]): string {
  const imports = [
    `import { test } from "vitest";`,
    `import { spawnSync } from "node:child_process";`,
    `import { ab, abWait, abAssertTextVisible, abAssertVisible, abAssertNotVisible, abAssertUrl, abAssertEnabled, abAssertDisabled, abAssertChecked, abAssertUnchecked } from "ccqa/test-helpers";`,
    "",
    `// Single session shared across all tests — reset per run via cookies clear in first test`,
    `process.env.AGENT_BROWSER_SESSION = \`ccqa-run-\${Date.now()}\`;`,
    "",
  ];

  const parts: string[] = [...imports];

  // Setup tests (same session — cookies clear in first setup ensures clean state)
  if (setupScripts?.length) {
    for (const setup of setupScripts) {
      parts.push(
        `test("setup: ${setup.name}", () => {`,
        setup.body,
        "}, 3 * 60 * 1000);",
        "",
      );
    }
  }

  // Main test (same session — setup state is preserved, no cookies clear)
  const testLines = actionsToLines(actions);
  const body = testLines.map((l) => `  ${l}`).join("\n");
  parts.push(
    `test(${JSON.stringify(title)}, () => {`,
    body,
    "}, 5 * 60 * 1000);",
    "",
  );

  return parts.join("\n");
}

/** Commands that interact with page elements and need the page to be loaded */
const ELEMENT_COMMANDS = new Set<string>(["click", "dblclick", "fill", "type", "check", "uncheck", "select", "hover", "drag"]);

function actionsToLines(actions: TraceAction[]): string[] {
  const lines: string[] = [];
  let prevLine: string | null = null;
  let prevCommand: string | null = null;
  for (const action of actions) {
    const line = actionToLine(action);
    if (line === null) continue;
    if (line === prevLine) continue;
    // After 'open', always insert a sleep — page load is guaranteed to be needed
    if (prevCommand === "open" && ELEMENT_COMMANDS.has(action.command)) {
      lines.push(`spawnSync("sleep", ["3"], { stdio: "inherit" });`);
    }
    lines.push(line);
    prevLine = line;
    prevCommand = action.command;
  }
  return lines;
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
      // Numeric waits represent sleep durations (from auto-fix)
      if (/^\d+$/.test(sel)) return `spawnSync("sleep", [${j(sel)}], { stdio: "inherit" });`;
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
          if (val) assertLine = `abAssertNotVisible(${j("text=" + val)}, 180_000);`;
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
          // is enabled is unreliable with text= and [aria-label=] selectors that may not exist in DOM
          if (sel && !sel.startsWith("text=") && !sel.startsWith("[aria-label=")) assertLine = `abAssertEnabled(${j(sel)});`;
          break;
        case "element_disabled":
          // is enabled is unreliable with text= and [aria-label=] selectors that may not exist in DOM
          if (sel && !sel.startsWith("text=") && !sel.startsWith("[aria-label=")) assertLine = `abAssertDisabled(${j(sel)});`;
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
