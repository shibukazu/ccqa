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

export interface EmptyStepNotice {
  /** Step id from spec.yaml that ended up with zero kept actions. */
  stepId: string;
  /** "spec" or block name — same shape as StepMarker.source. */
  source: string;
  /**
   * Where to splice the notice into the action list. -1 means "before
   * the first action" (e.g. step-01 lost everything); otherwise we put
   * it right after the action at this index, so it appears between two
   * neighbour steps in spec order.
   */
  insertAfterIndex: number;
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
  /**
   * Steps from spec.yaml that lost every action during post-trace
   * validation. The generator emits a visible warning comment block for
   * each so the spec author notices that the recorded test no longer
   * exercises that step.
   */
  emptySteps?: EmptyStepNotice[];
}

export function actionsToScript(input: ActionsToScriptInput): string {
  const { actions, testName, stepMarkers = [], emptySteps = [] } = input;

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

  const testLines = actionsToLines(actions, stepMarkers, emptySteps);
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
const ELEMENT_COMMANDS = new Set<string>([
  "click", "dblclick", "fill", "type", "check", "uncheck", "select", "hover", "drag",
  "find_click", "find_dblclick", "find_fill", "find_type", "find_hover", "find_focus",
  "find_check", "find_uncheck",
]);

function actionsToLines(
  actions: TraceAction[],
  stepMarkers: StepMarker[],
  emptySteps: EmptyStepNotice[],
): string[] {
  const lines: string[] = [];
  let prevLine: string | null = null;
  // True after an `open` until the next element interaction emits. We insert a
  // settle `sleep` before that first interaction so the freshly-navigated page
  // has time to render. Tracking it as a latch (rather than "prevCommand ===
  // 'open'") means intervening snapshot comments / replay-unstable breadcrumbs
  // don't swallow the sleep.
  let pendingOpenSettle = false;
  const markerByIndex = new Map(stepMarkers.map((m) => [m.actionIndex, m]));
  // Group empty-step notices by their splice-after index so multiple lost
  // steps in a row get one warning block each.
  const emptyByInsertAfter = new Map<number, EmptyStepNotice[]>();
  for (const e of emptySteps) {
    const list = emptyByInsertAfter.get(e.insertAfterIndex) ?? [];
    list.push(e);
    emptyByInsertAfter.set(e.insertAfterIndex, list);
  }
  // Notices that belong before the very first action (insertAfterIndex === -1).
  const leadingNotices = emptyByInsertAfter.get(-1) ?? [];
  for (const n of leadingNotices) appendEmptyStepNotice(lines, n);

  // Track values typed into input/contenteditable within the current step so
  // we can drop the "assert the typed value is visible text" over-assertion.
  // Input values live in the element's `value`, never as a visible text node,
  // so `abAssertTextVisible(<that value>)` can never pass (the input-value
  // trap). The spec's reflection intent is verified later on the result page.
  let currentStepId: string | undefined;
  let filledValuesThisStep = new Set<string>();

  for (let i = 0; i < actions.length; i++) {
    const marker = markerByIndex.get(i);
    if (marker) {
      if (lines.length > 0) lines.push("");
      lines.push(`// step: ${marker.stepId} [${marker.source}]`);
    }
    const action = actions[i]!;
    if (action.stepId !== currentStepId) {
      currentStepId = action.stepId;
      filledValuesThisStep = new Set();
    }
    const filled = fillValueOf(action);
    if (filled) filledValuesThisStep.add(filled);
    // Drop an input-value-trap assertion: text_visible on a value we just typed
    // into a field this step. Leave a breadcrumb; the result-page assertions
    // (list row / detail) carry the real verification.
    if (
      action.command === "assert" &&
      action.assertType === "text_visible" &&
      typeof action.value === "string" &&
      filledValuesThisStep.has(action.value)
    ) {
      lines.push(`// [warn] replay-unstable: dropped input-value assert (text_visible ${action.value}) — typed values aren't visible text nodes`);
      continue;
    }
    const line = actionToLine(action);
    if (line === null) continue;
    if (line === prevLine) continue;
    if (action.command === "open") pendingOpenSettle = true;
    if (pendingOpenSettle && ELEMENT_COMMANDS.has(action.command)) {
      lines.push(`spawnSync("sleep", ["3"], { stdio: "inherit" });`);
      pendingOpenSettle = false;
    }
    if (action.replayUnstable) {
      // Surface lenient-mode validation warnings inline so the auto-fix
      // loop can attribute a failing assertion to the underlying replay
      // instability rather than chasing a phantom selector drift.
      lines.push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
    }
    lines.push(line);
    prevLine = line;
    const followups = emptyByInsertAfter.get(i);
    if (followups) {
      for (const n of followups) appendEmptyStepNotice(lines, n);
    }
  }
  return lines;
}

/**
 * The text value a fill-type action types into a field, or null for
 * non-fill actions. Both the plain `fill`/`type` (value in `value`) and the
 * `find_fill`/`find_type` (also `value`) shapes carry it in `action.value`.
 */
function fillValueOf(action: TraceAction): string | null {
  const isFill =
    action.command === "fill" || action.command === "type" ||
    action.command === "find_fill" || action.command === "find_type";
  return isFill && typeof action.value === "string" && action.value.length > 0
    ? action.value
    : null;
}

function appendEmptyStepNotice(lines: string[], notice: EmptyStepNotice): void {
  if (lines.length > 0) lines.push("");
  lines.push(`// step: ${notice.stepId} [${notice.source}]`);
  lines.push(`// [warn] all actions for this step were dropped during post-trace validation.`);
  lines.push(`// [warn] the generated test does NOT exercise step ${notice.stepId}. Re-run`);
  lines.push(`// [warn] \`ccqa trace\` or add manual assertions if this step is load-bearing.`);
}

/**
 * Returns true if a selector is a session-specific agent-browser ref that
 * cannot be replayed. Two forms occur:
 *   - `@e14` — the snapshot ref syntax (interactions)
 *   - `button[ref='e4']` / `[ref=e4]` — the ref attribute leaking into a CSS
 *     selector (most often via an assert the agent built from a snapshot row)
 * Refs are re-numbered on every snapshot, so neither survives a fresh run.
 */
function isRefSelector(selector: string | undefined): boolean {
  if (typeof selector !== "string") return false;
  const s = selector.trim();
  return /^@/.test(s) || /\[ref\s*=\s*['"]?e\d+['"]?\]/.test(s);
}

/**
 * Returns true if a selector picks elements *by the very state being asserted*,
 * which makes an `element_disabled` / `element_enabled` check a tautology.
 *
 * `abAssertDisabled("button[disabled]")` resolves to `is enabled
 * "button[disabled]"`: it first selects an already-disabled element, then
 * confirms it is disabled — always true, and true even when the *target* the
 * spec cares about (e.g. the "コンテンツの追加" button) is missing or enabled.
 * The agent emits these when it reaches for "the disabled button" instead of
 * naming the element by a state-independent selector. The assertion verifies
 * nothing, so codegen drops it (breadcrumb only) rather than baking a green
 * check that can never fail.
 *
 * Matches the `:disabled` / `:enabled` pseudo-classes and the `[disabled]` /
 * `[aria-disabled=…]` attribute selectors anywhere in the selector.
 */
function isStateSelector(selector: string | undefined): boolean {
  if (typeof selector !== "string") return false;
  return /:disabled\b|:enabled\b|\[\s*disabled[\s\]=]|\[\s*aria-disabled[\s\]=]/i.test(selector);
}

function actionToLine(action: TraceAction): string | null {
  // Skip actions that use @ref selectors — they are session-specific and not replayable
  if ("selector" in action && isRefSelector(action.selector)) return null;

  // Drop over-assertions: an element_* assert whose selector the validator
  // could not even find (`get count` returned 0) is targeting an accessible
  // name with no matching DOM attribute — it will fail on every run. These
  // carry a `selector not present` replayReason. Leave a breadcrumb comment
  // (not a runnable line) so the dropped check is visible. We keep `Wait timed
  // out` / cascade-skipped asserts (those may pass in a real run where prior
  // state built up correctly), and we never touch non-assert actions here.
  if (
    action.command === "assert" &&
    action.replayUnstable &&
    typeof action.replayReason === "string" &&
    action.replayReason.includes("selector not present")
  ) {
    const sel = action.selector ?? action.observation ?? "(unknown)";
    return `// [warn] replay-unstable: dropped over-assertion (${action.assertType ?? "assert"} ${sel}) — selector not present on replay`;
  }

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
      // Flag-form waits (`--load networkidle`, `--fn "..."`, `--url "..."`) are
      // readiness/observation conditions, not part of the user flow. The
      // AB_ACTION wire format can't faithfully round-trip their argument (the
      // JS expression / glob lands in the label slot or is lost), so emitting
      // them produces broken calls like `ab("wait", "--fn")`. Skip them — the
      // following assertion (abAssertTextVisible etc.) provides the real wait.
      if (sel.startsWith("--")) return null;
      // `${ENV_VAR}` refs in a wait selector (e.g. `text=run-${CCQA_TEST_RUN_ID}`)
      // must expand to a template literal so the live env value reaches the
      // selector at run time. Same shape as `fill` / `assert` values.
      return `abWait(${jExpr(sel)});`;
    }

    case "find_click":
    case "find_dblclick":
    case "find_hover":
    case "find_focus":
    case "find_check":
    case "find_uncheck": {
      const args = buildFindArgs(action, undefined);
      return args === null ? droppedFindMarker(action) : `ab(${args.join(", ")});`;
    }

    case "find_fill":
    case "find_type": {
      // agent-browser's `find` only knows `fill` — `type` is a ccqa-side
      // alias that maps to `fill` at codegen time.
      const args = buildFindArgs(action, action.value ?? "");
      return args === null ? droppedFindMarker(action) : `ab(${args.join(", ")});`;
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
          // Tautology guard: a selector that picks elements by their state
          // (`:enabled`, `[disabled]`, …) verifies nothing — drop with a breadcrumb.
          if (isStateSelector(sel)) return tautologicalStateAssertMarker(action, sel);
          // is enabled is unreliable with text= and [aria-label=] selectors that may not exist in DOM
          if (sel && !sel.startsWith("text=") && !sel.startsWith("[aria-label=")) assertLine = `abAssertEnabled(${j(sel)});`;
          break;
        case "element_disabled":
          if (isStateSelector(sel)) return tautologicalStateAssertMarker(action, sel);
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

/**
 * Build the argument list for `ab("find", ...)` codegen. Layout matches the
 * `agent-browser find <locator> <value> [--name <n>] [--exact] <action>
 * [fillValue]` invocation shape. `findValue` and `findName` go through
 * `jExpr` so `${ENV}` references survive into the generated test; the
 * positional CSS selector inside `first/last/nth` stays as a plain string
 * literal.
 */
function buildFindArgs(action: TraceAction, fillValue: string | undefined): string[] | null {
  // Defensive: if a stray find_* action sneaked into actions.json without the
  // required locator/value fields, refuse to codegen it. Otherwise we'd emit
  // `ab("find", , , "click")` (a syntax error) into test.spec.ts.
  const { findLocator, findValue } = action;
  if (!findLocator || !findValue) return null;
  const innerAction = action.command.slice("find_".length).replace("type", "fill");
  const args = [JSON.stringify("find"), JSON.stringify(findLocator)];
  if (findLocator === "nth") {
    // `ab(...args: string[])` only accepts strings — emit the index as a
    // quoted literal even though it's semantically numeric.
    args.push(JSON.stringify(String(action.findIndex ?? 0)));
    args.push(j(findValue));
  } else if (findLocator === "first" || findLocator === "last") {
    args.push(j(findValue));
  } else {
    args.push(jExpr(findValue));
  }
  // agent-browser expects `<value> <action> [--name <n>] [--exact]` —
  // flags MUST follow the action token. Putting them before it produced
  // "Unknown subaction: --name" on every find_role call in the trace.
  args.push(JSON.stringify(innerAction));
  if (fillValue !== undefined) {
    args.push(jExpr(fillValue));
  }
  // `--name` is role-only. Defend against a stray findName slipping into
  // actions.json from another locator — agent-browser rejects it.
  if (findLocator === "role" && action.findName) {
    args.push(JSON.stringify("--name"), jExpr(action.findName));
  }
  if (action.findExact) {
    args.push(JSON.stringify("--exact"));
  }
  return args;
}

/**
 * Emit a visible breadcrumb when a `find_*` action lacks the locator/value
 * fields that codegen needs. We can't generate a runnable `ab(...)` line, but
 * a silent skip would make the test pass while quietly dropping a step the
 * spec author cared about. The marker is a TS comment so the file still
 * parses, but `grep -n "find_\\* dropped"` surfaces the issue in CI logs.
 */
function droppedFindMarker(action: TraceAction): string {
  const ctx = action.stepId ? ` (stepId=${action.stepId})` : "";
  return `// [warn] find_* dropped: ${action.command}${ctx} — actions.json is missing findLocator/findValue. Re-run \`ccqa trace\` to regenerate.`;
}

/**
 * Breadcrumb for an `element_enabled` / `element_disabled` assert whose selector
 * picks the element by the asserted state (a tautology — see `isStateSelector`).
 * Dropped from the runnable script; surfaces in the test so a reviewer sees the
 * intended check was discarded and can re-assert against a state-independent
 * selector if the state really matters.
 */
function tautologicalStateAssertMarker(action: TraceAction, sel: string | undefined): string {
  return `// [warn] dropped tautological assert (${action.assertType ?? "assert"} ${sel ?? "(unknown)"}) — selector matches by the asserted state; target the element by a state-independent selector instead`;
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
