import { envRefsToJsExpression } from "../runtime/env-vars.ts";
import type { TraceAction } from "../types.ts";

/**
 * Convert recorded trace actions into a vitest-compatible test.spec.ts.
 * One spec produces one `test()` body. The first action in the trace is
 * itself an explicit `open`, recorded from the spec/block step that opens
 * the page.
 *
 * `agent-browser` is invoked via `child_process.spawnSync` with explicit
 * argument arrays to avoid shell quoting issues; the binary is resolved
 * via PATH (peer install).
 *
 * Env refs (`$VAR` / `${VAR}`) in user-supplied values (form fills, asserted
 * URLs, asserted texts, opened URLs) are emitted as `process.env.VAR ?? ""`
 * template literals so the test never bakes a secret into the script.
 * Selectors do not go through this transform — they're treated as literal
 * strings (a stray `$` in a selector is escaped verbatim).
 */

export interface StepMarker {
  /** Position in the action stream where the step begins (0-based). */
  actionIndex: number;
  /** Step id as assigned by `expandSpec` ("step-01" etc.). */
  stepId: string;
  /** "spec" or block name — included in the comment for traceability. */
  source: string;
}

export interface ActionsToScriptInput {
  actions: TraceAction[];
  /** Name shown in vitest output — typically the spec.yaml title. */
  testName: string;
  /**
   * Optional per-step markers. When provided, the generator inserts a
   * `// step: <id> [<source>]` comment line at each marker so the
   * generated script and any failure output identifies which spec step
   * we're inside. The source for inlined block steps is the block name.
   */
  stepMarkers?: StepMarker[];
}

export function actionsToScript(input: ActionsToScriptInput): string {
  const { actions, testName, stepMarkers = [] } = input;

  const helperImports = [
    "ab", "abWait", "abAssertTextVisible", "abAssertVisible", "abAssertNotVisible",
    "abAssertUrl", "abAssertEnabled", "abAssertDisabled", "abAssertChecked", "abAssertUnchecked",
  ];

  const imports = [
    `import { test } from "vitest";`,
    `import { spawnSync } from "node:child_process";`,
    `import { ${helperImports.join(", ")} } from "ccqa/test-helpers";`,
    "",
    `// Single session shared across the run. Use ||= so an outer harness`,
    `// (e.g. ccqa generate's auto-fix loop) can pre-set the session name`,
    `// and inspect the same session after the run finishes.`,
    `process.env.AGENT_BROWSER_SESSION ||= \`ccqa-run-\${Date.now()}\`;`,
    "",
  ];

  const parts: string[] = [...imports];

  const testLines = actionsToLines(actions, stepMarkers);
  const body = testLines.map((l) => `  ${l}`).join("\n");
  parts.push(
    `test(${JSON.stringify(testName)}, () => {`,
    body,
    "}, 5 * 60 * 1000);",
    "",
  );

  return parts.join("\n");
}

/** Commands that interact with page elements and need the page to be loaded */
const ELEMENT_COMMANDS = new Set<string>(["click", "dblclick", "fill", "type", "check", "uncheck", "select", "hover", "drag"]);

function actionsToLines(actions: TraceAction[], stepMarkers: StepMarker[]): string[] {
  const lines: string[] = [];
  let prevLine: string | null = null;
  let prevCommand: string | null = null;
  const markerByIndex = new Map(stepMarkers.map((m) => [m.actionIndex, m]));

  for (let i = 0; i < actions.length; i++) {
    const marker = markerByIndex.get(i);
    if (marker) {
      if (lines.length > 0) lines.push("");
      lines.push(`// step: ${marker.stepId} [${marker.source}]`);
    }
    const action = actions[i]!;
    const line = actionToLine(action);
    if (line === null) continue;
    if (line === prevLine) continue;
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
      return `ab("open", ${jExpr(url)});`;
    }

    case "snapshot":
      return action.observation ? `// ${action.observation}` : null;

    case "click":
      return `ab("click", ${j(action.selector!)});`;

    case "dblclick":
      return `ab("dblclick", ${j(action.selector!)});`;

    case "fill":
      return `ab("fill", ${j(action.selector!)}, ${jExpr(action.value!)});`;

    case "type":
      return `ab("fill", ${j(action.selector!)}, ${jExpr(action.value!)});`;

    case "check":
      return `ab("check", ${j(action.selector!)});`;

    case "uncheck":
      return `ab("uncheck", ${j(action.selector!)});`;

    case "press":
      return `ab("press", ${jExpr(action.value!)});`;

    case "select":
      return `ab("select", ${j(action.selector!)}, ${jExpr(action.value!)});`;

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
      // `${ENV_VAR}` refs in a wait selector (e.g. `text=run-${CCQA_TEST_RUN_ID}`)
      // must expand to a template literal so the live env value reaches the
      // selector at run time. Same shape as `fill` / `assert` values.
      return `abWait(${jExpr(sel)});`;
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
          if (val) assertLine = `abAssertTextVisible(${jExpr(val)});`;
          break;
        case "text_not_visible":
          if (val) assertLine = `abAssertNotVisible(${jExpr("text=" + val)}, 180_000);`;
          break;
        case "element_visible":
          if (sel) assertLine = `abAssertVisible(${j(sel)});`;
          break;
        case "element_not_visible":
          if (sel) assertLine = `abAssertNotVisible(${j(sel)});`;
          break;
        case "url_contains":
          if (val) assertLine = `abAssertUrl(${jExpr(val)});`;
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

/**
 * Like `j`, but recognises `$VAR` / `${VAR}` env-ref forms in the value and
 * emits them as `${process.env.VAR ?? ""}` template-literal substitutions
 * instead of baking the literal `$VAR` string into the script. Used for
 * values that came from a spec or block param: form fills, opened URLs,
 * assertion texts/URLs.
 */
const jExpr = (s: string) => envRefsToJsExpression(s);
