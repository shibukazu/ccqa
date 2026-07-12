import { envRefsToJsExpression } from "../runtime/env-vars.ts";
import { locatorToSelector, toAgentBrowserArgs, type AbToken } from "../ir/to-agent-browser.ts";
import type { RecordedAction } from "../ir/types.ts";

/**
 * Convert a recording (IR) into a vitest-compatible test.spec.ts.
 * One spec produces one `test()` body. The first action in the recording is
 * itself an explicit `navigate`, recorded from the spec/block step that opens
 * the page.
 *
 * `agent-browser` is invoked via `child_process.spawnSync` with explicit
 * argument arrays to avoid shell quoting issues; the binary is resolved
 * via PATH (peer install). The argv for each action comes from the shared
 * `ir/to-agent-browser.ts` mapping.
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
  actions: RecordedAction[];
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
    "ab", "abWait", "abUpload",
    "abAssertTextVisible", "abAssertVisible", "abAssertNotVisible",
    "abAssertUrl", "abAssertEnabled", "abAssertDisabled", "abAssertChecked", "abAssertUnchecked",
    "abStepEvidence",
    "__setCurrentStep",
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

/** Actions that interact with page elements and need the page to be loaded */
const ELEMENT_ACTIONS = new Set<RecordedAction["action"]>([
  "click", "dblclick", "fill", "type", "check", "uncheck", "select", "hover",
  "focus", "drag", "upload",
]);

function actionsToLines(
  actions: RecordedAction[],
  stepMarkers: StepMarker[],
  emptySteps: EmptyStepNotice[],
): string[] {
  const lines: string[] = [];
  let prevLine: string | null = null;
  // True after a `navigate` until the next element interaction emits. We
  // insert a settle `sleep` before that first interaction so the freshly-
  // navigated page has time to render. Tracking it as a latch (rather than
  // "prevAction === 'navigate'") means intervening snapshot comments /
  // replay-unstable breadcrumbs don't swallow the sleep.
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
  // Tracks the most recently opened step marker so we can flush
  // `abStepEvidence(...)` right before the next marker (and once at the end).
  let openMarker: StepMarker | null = null;

  for (let i = 0; i < actions.length; i++) {
    const marker = markerByIndex.get(i);
    if (marker) {
      if (openMarker) lines.push(`abStepEvidence(${j(openMarker.stepId)}, ${j(openMarker.source)});`);
      if (lines.length > 0) lines.push("");
      lines.push(`// step: ${marker.stepId} [${marker.source}]`);
      // Tell the runtime which step we're inside so fail() can attribute
      // failures back to it. abStepEvidence at the end of the step clears it.
      lines.push(`__setCurrentStep(${j(marker.stepId)}, ${j(marker.source)});`);
      openMarker = marker;
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
      action.action === "assert" &&
      action.assert === "text_visible" &&
      typeof action.value === "string" &&
      filledValuesThisStep.has(action.value)
    ) {
      lines.push(`// [warn] replay-unstable: dropped input-value assert (text_visible ${action.value}) — typed values aren't visible text nodes`);
      continue;
    }
    const line = actionToLine(action);
    if (line === null) continue;
    if (line === prevLine) continue;
    if (action.action === "navigate") pendingOpenSettle = true;
    if (pendingOpenSettle && ELEMENT_ACTIONS.has(action.action)) {
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
  if (openMarker) lines.push(`abStepEvidence(${j(openMarker.stepId)}, ${j(openMarker.source)});`);
  return lines;
}

/**
 * The text value a fill-type action types into a field, or null for
 * non-fill actions.
 */
function fillValueOf(action: RecordedAction): string | null {
  const isFill = action.action === "fill" || action.action === "type";
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
 * spec cares about (e.g. the "Submit" button) is missing or enabled.
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

/** The raw selector-string form of an action's locator, when it has one. */
function plainSelectorOf(action: RecordedAction): string | undefined {
  return action.locator && action.index === undefined
    ? locatorToSelector(action.locator)
    : undefined;
}

function actionToLine(action: RecordedAction): string | null {
  // Skip actions that use @ref selectors — they are session-specific and not replayable
  if (isRefSelector(plainSelectorOf(action))) return null;

  // Drop over-assertions: an element_* assert whose selector the validator
  // could not even find (`get count` returned 0) is targeting an accessible
  // name with no matching DOM attribute — it will fail on every run. These
  // carry a `selector not present` replayReason. Leave a breadcrumb comment
  // (not a runnable line) so the dropped check is visible. We keep `Wait timed
  // out` / cascade-skipped asserts (those may pass in a real run where prior
  // state built up correctly), and we never touch non-assert actions here.
  if (
    action.action === "assert" &&
    action.replayUnstable &&
    typeof action.replayReason === "string" &&
    action.replayReason.includes("selector not present")
  ) {
    const sel = plainSelectorOf(action) ?? action.observation ?? "(unknown)";
    return `// [warn] replay-unstable: dropped over-assertion (${action.assert ?? "assert"} ${sel}) — selector not present on replay`;
  }

  switch (action.action) {
    case "snapshot":
      return action.observation ? `// ${action.observation}` : null;

    case "wait": {
      const sel = plainSelectorOf(action);
      if (!sel) return null;
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

    case "upload": {
      // File paths run through `jExpr` so `${FIXTURE_DIR}/sample.pdf` survives
      // codegen as a template literal that resolves at test run time, the same
      // shape fill values use.
      const tokens = toAgentBrowserArgs(action);
      if (tokens === null) return null;
      return `abUpload(${tokens.slice(1).map(renderToken).join(", ")});`;
    }

    case "assert": {
      // LLM may omit locator/value fields and put the text in observation instead
      // Fall back to observation when the specific field is missing
      const val = action.value ?? action.observation;
      const sel = plainSelectorOf(action) ?? action.observation;
      const comment = action.observation ? `// Assert: ${action.observation}` : null;
      let assertLine: string | null = null;
      switch (action.assert) {
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

    default: {
      // Everything else replays as a plain agent-browser invocation whose
      // argv comes from the shared IR mapping (navigate, click/fill families,
      // find forms, scroll, drag, cookies_clear, ...).
      const tokens = toAgentBrowserArgs(action);
      if (tokens === null) {
        return ELEMENT_ACTIONS.has(action.action) ? droppedActionMarker(action) : null;
      }
      return `ab(${tokens.map(renderToken).join(", ")});`;
    }
  }
}

/**
 * Render one argv token into TS source: env-expandable tokens (fill values,
 * URLs, find texts) become template literals via `jExpr`; everything else
 * (command words, flags, raw CSS selectors) is a plain string literal.
 */
function renderToken(token: AbToken): string {
  return token.expandsEnv ? jExpr(token.text) : j(token.text);
}

/**
 * Emit a visible breadcrumb when an element action lacks the locator fields
 * that codegen needs. We can't generate a runnable `ab(...)` line, but a
 * silent skip would make the test pass while quietly dropping a step the
 * spec author cared about. The marker is a TS comment so the file still
 * parses, but `grep -n "action dropped"` surfaces the issue in CI logs.
 */
function droppedActionMarker(action: RecordedAction): string {
  const ctx = action.stepId ? ` (stepId=${action.stepId})` : "";
  return `// [warn] action dropped: ${action.action}${ctx} — ir.json is missing its locator. Re-run \`ccqa record\` to regenerate.`;
}

/**
 * Breadcrumb for an `element_enabled` / `element_disabled` assert whose selector
 * picks the element by the asserted state (a tautology — see `isStateSelector`).
 * Dropped from the runnable script; surfaces in the test so a reviewer sees the
 * intended check was discarded and can re-assert against a state-independent
 * selector if the state really matters.
 */
function tautologicalStateAssertMarker(action: RecordedAction, sel: string | undefined): string {
  return `// [warn] dropped tautological assert (${action.assert ?? "assert"} ${sel ?? "(unknown)"}) — selector matches by the asserted state; target the element by a state-independent selector instead`;
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
