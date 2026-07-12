import { envRefsToJsExpression } from "../../runtime/env-vars.ts";
import type { Locator, LocatorIndex, RecordedAction } from "../../ir/types.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";

/**
 * Deterministic IR → plain `@playwright/test` emitter — no LLM involved.
 * Produces the "mechanical draft": a 1:1 compilation of the recorded route
 * that the library-reuse LLM pass treats as ground truth (or that ships
 * as-is when no resources are configured).
 *
 * Follows the agent-browser emitter's conventions: `// step: <id> [<source>]`
 * comments at step boundaries, `// [warn] replay-unstable: ...` breadcrumbs,
 * observation-only snapshots as comments, and env refs (`$VAR` / `${VAR}`)
 * in user-supplied values emitted as `process.env.VAR ?? ""` template
 * literals so secrets never bake into the script.
 */

export interface PlaywrightEmitInput {
  actions: RecordedAction[];
  /** Test name — typically the spec.yaml title. */
  testName: string;
  stepMarkers?: StepMarker[];
}

export function emitPlaywrightDraft(input: PlaywrightEmitInput): string {
  const { actions, testName, stepMarkers = [] } = input;
  const markerByIndex = new Map(stepMarkers.map((m) => [m.actionIndex, m]));

  const lines: string[] = [];
  let prevLine: string | null = null;
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
    if (action.replayUnstable) {
      lines.push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
    }
    lines.push(line);
    prevLine = line;
  }

  const body = lines.map((l) => (l === "" ? "" : `  ${l}`)).join("\n");
  return [
    `import { test, expect } from "@playwright/test";`,
    "",
    `test(${j(testName)}, async ({ page }) => {`,
    body,
    "});",
    "",
  ].join("\n");
}

/**
 * Render a locator (plus positional pick) as a Playwright locator expression.
 * Semantic strategies map 1:1 onto the getBy* family; `by: "css"` keeps its
 * raw selector-engine string (locator() accepts `text=...` forms verbatim).
 */
export function locatorToPlaywright(locator: Locator, index?: LocatorIndex): string {
  let expr: string;
  switch (locator.by) {
    case "role": {
      const opts: string[] = [];
      if (locator.name) opts.push(`name: ${jExpr(locator.name)}`);
      if (locator.exact) opts.push(`exact: true`);
      const optArg = opts.length > 0 ? `, { ${opts.join(", ")} }` : "";
      expr = `page.getByRole(${j(locator.value)}${optArg})`;
      break;
    }
    case "text":
      expr = `page.getByText(${jExpr(locator.value)}${exactArg(locator.exact)})`;
      break;
    case "label":
      expr = `page.getByLabel(${jExpr(locator.value)}${exactArg(locator.exact)})`;
      break;
    case "placeholder":
      expr = `page.getByPlaceholder(${jExpr(locator.value)}${exactArg(locator.exact)})`;
      break;
    case "alt":
      expr = `page.getByAltText(${jExpr(locator.value)}${exactArg(locator.exact)})`;
      break;
    case "title":
      expr = `page.getByTitle(${jExpr(locator.value)}${exactArg(locator.exact)})`;
      break;
    case "testid":
      // getByTestId matches exactly by definition — `exact` doesn't apply.
      expr = `page.getByTestId(${jExpr(locator.value)})`;
      break;
    case "css":
      expr = `page.locator(${j(locator.value)})`;
      break;
  }
  if (index === "first") return `${expr}.first()`;
  if (index === "last") return `${expr}.last()`;
  if (typeof index === "number") return `${expr}.nth(${index})`;
  return expr;
}

function exactArg(exact: boolean | undefined): string {
  return exact ? ", { exact: true }" : "";
}

/** Default wheel delta for scrolls recorded without an explicit pixel count. */
const DEFAULT_SCROLL_PIXELS = 400;

function actionToLine(action: RecordedAction): string | null {
  // Same rule as the agent-browser emitter: an element assert whose selector
  // the post-trace validator could not even find (`get count` returned 0)
  // fails on every run — emit a breadcrumb comment instead of a runnable line.
  if (
    action.action === "assert" &&
    action.replayUnstable &&
    typeof action.replayReason === "string" &&
    action.replayReason.includes("selector not present")
  ) {
    const sel = action.locator?.value ?? action.observation ?? "(unknown)";
    return `// [warn] replay-unstable: dropped over-assertion (${action.assert ?? "assert"} ${sel}) — selector not present on replay`;
  }

  const locator = action.locator ? locatorToPlaywright(action.locator, action.index) : null;

  switch (action.action) {
    case "navigate":
      return `await page.goto(${jExpr(action.value ?? "")});`;
    case "click":
      return locator ? `await ${locator}.click();` : droppedActionMarker(action);
    case "dblclick":
      return locator ? `await ${locator}.dblclick();` : droppedActionMarker(action);
    case "fill":
    case "type":
      // `type` is ccqa's alias of `fill` (same as the agent-browser mapping).
      return locator
        ? `await ${locator}.fill(${jExpr(action.value ?? "")});`
        : droppedActionMarker(action);
    case "press":
      return locator
        ? `await ${locator}.press(${jExpr(action.value ?? "")});`
        : `await page.keyboard.press(${jExpr(action.value ?? "")});`;
    case "check":
      return locator ? `await ${locator}.check();` : droppedActionMarker(action);
    case "uncheck":
      return locator ? `await ${locator}.uncheck();` : droppedActionMarker(action);
    case "select":
      return locator
        ? `await ${locator}.selectOption(${jExpr(action.value ?? "")});`
        : droppedActionMarker(action);
    case "hover":
      return locator ? `await ${locator}.hover();` : droppedActionMarker(action);
    case "focus":
      return locator ? `await ${locator}.focus();` : droppedActionMarker(action);
    case "drag": {
      if (!locator || !action.target) return droppedActionMarker(action);
      return `await ${locator}.dragTo(${locatorToPlaywright(action.target)});`;
    }
    case "upload": {
      const files = action.files ?? [];
      if (!locator || files.length === 0) return droppedActionMarker(action);
      return `await ${locator}.setInputFiles([${files.map(jExpr).join(", ")}]);`;
    }
    case "scroll":
      return scrollToLine(action);
    case "wait":
      return waitToLine(action, locator);
    case "assert":
      return assertToLine(action, locator);
    case "snapshot":
      return action.observation ? `// ${action.observation}` : null;
    case "cookies_clear":
      return `await page.context().clearCookies();`;
  }
}

function scrollToLine(action: RecordedAction): string {
  const px = action.pixels ? parseInt(action.pixels, 10) || DEFAULT_SCROLL_PIXELS : DEFAULT_SCROLL_PIXELS;
  switch (action.direction ?? "down") {
    case "up":
      return `await page.mouse.wheel(0, ${-px});`;
    case "left":
      return `await page.mouse.wheel(${-px}, 0);`;
    case "right":
      return `await page.mouse.wheel(${px}, 0);`;
    default:
      return `await page.mouse.wheel(0, ${px});`;
  }
}

function waitToLine(action: RecordedAction, locator: string | null): string | null {
  const loc = action.locator;
  if (!loc || !locator) return null;
  if (loc.by === "css") {
    // Numeric waits are recorded sleep durations (seconds, from auto-fix).
    if (/^\d+$/.test(loc.value)) {
      return `await page.waitForTimeout(${parseInt(loc.value, 10) * 1000});`;
    }
    // Flag-form waits (`--load`, `--fn`, `--url`) are readiness probes whose
    // argument doesn't round-trip — skip, like the agent-browser emitter.
    if (loc.value.startsWith("--")) return null;
  }
  // agent-browser `wait` means "appears anywhere"; `.first()` keeps that
  // semantic under Playwright's strict mode (unless a pick already applied).
  const pick = action.index === undefined ? ".first()" : "";
  return `await ${locator}${pick}.waitFor();`;
}

function assertToLine(action: RecordedAction, locator: string | null): string | null {
  // Like the agent-browser emitter: the LLM may put the expectation text in
  // `observation` instead of `value`.
  const value = action.value ?? action.observation;
  const comment = action.observation ? `// Assert: ${action.observation}` : null;
  // Element asserts come from `get count`-style probes, whose semantic is
  // "at least one such element" — `.first()` keeps that valid under strict
  // mode when several match (unless an explicit index pick already applied).
  const pick = action.index === undefined ? ".first()" : "";

  let assertLine: string | null = null;
  switch (action.assert) {
    case "text_visible":
      // `.first()`: the recorded semantic is "the text is visible somewhere".
      if (value) assertLine = `await expect(page.getByText(${jExpr(value)}).first()).toBeVisible();`;
      break;
    case "text_not_visible":
      if (value) assertLine = `await expect(page.getByText(${jExpr(value)})).toHaveCount(0);`;
      break;
    case "element_visible":
      if (locator) assertLine = `await expect(${locator}${pick}).toBeVisible();`;
      break;
    case "element_not_visible":
      // `get count` == 0 — same idiom as text_not_visible, strict-mode safe.
      if (locator) assertLine = `await expect(${locator}).toHaveCount(0);`;
      break;
    case "url_contains":
      if (value) assertLine = urlContainsAssert(value);
      break;
    case "element_enabled":
      if (locator) assertLine = `await expect(${locator}).toBeEnabled();`;
      break;
    case "element_disabled":
      if (locator) assertLine = `await expect(${locator}).toBeDisabled();`;
      break;
    case "element_checked":
      if (locator) assertLine = `await expect(${locator}).toBeChecked();`;
      break;
    case "element_unchecked":
      if (locator) assertLine = `await expect(${locator}).not.toBeChecked();`;
      break;
    case undefined:
      break;
  }
  if (comment && assertLine) return `${comment}\n  ${assertLine}`;
  return assertLine ?? comment;
}

/**
 * `url_contains` → toHaveURL. Literal values become an unanchored RegExp
 * (substring match); values carrying env refs can't live in a regex literal,
 * so they use toHaveURL's glob form with a template literal.
 */
function urlContainsAssert(value: string): string {
  const expr = jExpr(value);
  if (expr.startsWith("`")) {
    return `await expect(page).toHaveURL(${envRefsToJsExpression(`**${value}**`)});`;
  }
  return `await expect(page).toHaveURL(new RegExp(${j(escapeRegExp(value))}));`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Same visible breadcrumb as the agent-browser emitter for unemittable actions. */
function droppedActionMarker(action: RecordedAction): string {
  const ctx = action.stepId ? ` (stepId=${action.stepId})` : "";
  return `// [warn] action dropped: ${action.action}${ctx} — ir.json is missing its locator. Re-run \`ccqa record\` to regenerate.`;
}

/** JSON.stringify — a quoted string literal safe for embedding in TS source. */
const j = (s: string): string => JSON.stringify(s);

/**
 * Like `j`, but `$VAR` / `${VAR}` refs become `process.env.VAR ?? ""`
 * template-literal substitutions (same transform the agent-browser emitter
 * applies to user-supplied values).
 */
const jExpr = (s: string): string => envRefsToJsExpression(s);
