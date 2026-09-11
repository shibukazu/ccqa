import type { ExpandedJudgeByLlmStep } from "../../spec/expand.ts";
import { bracedRefsToJsExpression, envRefsToJsExpression } from "../../runtime/env-vars.ts";
import type { Locator, LocatorIndex, RecordedAction } from "../../ir/types.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";
import { renderStepComment } from "../../codegen/step-comment.ts";

/**
 * Deterministic IR → plain `@playwright/test` emitter — no LLM involved.
 * Produces the "mechanical draft": a 1:1 compilation of the recorded route
 * that the library-reuse LLM pass treats as ground truth (or that ships
 * as-is when no resources are configured).
 *
 * Follows the agent-browser emitter's conventions: `// step: <id> [<source>]`
 * comments at step boundaries, a screenshot capture call on each side of a
 * step (the Playwright counterpart of `abStepEvidence`, see
 * `ccqa/step-evidence`), `// [warn] replay-unstable: ...` breadcrumbs,
 * observation-only snapshots as comments, and env refs (`$VAR` / `${VAR}`)
 * in user-supplied values emitted as `process.env.VAR ?? ""` template
 * literals so secrets never bake into the script.
 */

export interface PlaywrightEmitInput {
  actions: RecordedAction[];
  /** Test name — typically the spec.yaml title. */
  testName: string;
  stepMarkers?: StepMarker[];
  /**
   * Claims to assert, each after the actions of the step it follows in the
   * spec. Emitted here rather than left to the rewrite: a claim the generator
   * dropped would leave a spec asserting nothing and still green.
   */
  judgements?: Judgement[];
  /**
   * Comment block the file opens with — where the case came from, as the
   * project writes it. Already expanded by the caller; emitted verbatim.
   */
  header?: string;
  /** Appended to the test's name, e.g. a priority tag the project greps for. */
  titleSuffix?: string;
  /**
   * What to undo afterwards. Emitted as `test.afterEach`, guarded so a test
   * that failed before it created anything cleans up nothing.
   */
  cleanup?: { actions: RecordedAction[]; stepMarkers?: StepMarker[] };
  /**
   * How the project names the unique values a run creates. Given, the recorded
   * `${CCQA_RUN_ID}` is emitted as a call to it, evaluated once per attempt —
   * so the generated test carries the project's own convention rather than an
   * environment variable ccqa happens to set.
   */
  runId?: { import: string; expression: string };
  /** False drops the per-step capture calls (config `hooks.stepEvidence`). */
  stepEvidence?: boolean;
  /** Write the step comments in Japanese (the CLI's `--language`). */
  japanese?: boolean;
}

/**
 * Names the emitted test declares. The project maintains this file from here
 * on, so they say what they hold rather than which tool wrote them.
 */
const RUN_ID_VAR = "uniqueValue";
/**
 * Flag the `afterEach` guards on. Separate from {@link RUN_ID_VAR}, which is
 * assigned at the top of the test because the steps type it: a guard on that
 * one would be true before anything had been created.
 */
const CREATED_VAR = "createdSomething";
/** Environment variable the recording carries a unique value as. */
const RUN_ID_ENV = "CCQA_RUN_ID";
/** What the recording holds where a run's unique value went. */
const RUN_ID_REF = `\${${RUN_ID_ENV}}`;
/** What `envRefsToJsExpression` renders `${CCQA_RUN_ID}` as. */
const RUN_ID_READ = `process.env.${RUN_ID_ENV} ?? ""`;

/** Actions that put a value into the page, and those that submit it. */
const TYPING_ACTIONS = new Set<RecordedAction["action"]>(["fill", "type", "select"]);
const SUBMITTING_ACTIONS = new Set<RecordedAction["action"]>(["click", "dblclick", "press"]);

/**
 * The action after which the route has created the thing the cleanup undoes.
 *
 * Mechanical, so a reader can predict it: the first action that submits
 * (a click, a double click, a key press) after the first one that typed the
 * run's unique value — and then the end of that action's step, since what the
 * step does is one act. A route that types the value and never submits it, or
 * never types it at all, has no such moment, so the last action stands in:
 * assigning at the end is still later than the creation, and never earlier.
 */
export function creationActionIndex(
  actions: readonly RecordedAction[],
  markers: readonly StepMarker[],
): number {
  const last = actions.length - 1;
  const typed = actions.findIndex(
    (a) => TYPING_ACTIONS.has(a.action) && (a.value ?? "").includes(RUN_ID_REF),
  );
  if (typed === -1) return last;
  const submitted = actions.findIndex((a, i) => i > typed && SUBMITTING_ACTIONS.has(a.action));
  if (submitted === -1) return last;
  const next = markers.find((m) => m.actionIndex > submitted);
  return next ? next.actionIndex - 1 : last;
}

/** A claim and the action index it is asserted after (-1: before any action). */
export interface Judgement {
  step: ExpandedJudgeByLlmStep;
  afterActionIndex: number;
}

/** Module the emitted step-boundary capture calls import from. */
export const STEP_EVIDENCE_MODULE = "ccqa/step-evidence";

/** Module the emitted judge calls import from, and the call they make. */
export const JUDGE_MODULE = "ccqa/judge";
export const JUDGE_CALL = "judgeByLlm";

/** Capture call emitted when a step is entered / closed. Exported for the generation gate. */
export const STEP_EVIDENCE_BEFORE = "ccqaStepBefore";
export const STEP_EVIDENCE_AFTER = "ccqaStepAfter";

/** The exact boundary call for one step, as emitted and as the gate greps for it. */
export function stepEvidenceCall(
  fn: typeof STEP_EVIDENCE_BEFORE | typeof STEP_EVIDENCE_AFTER,
  marker: Pick<StepMarker, "stepId" | "source">,
): InjectedCall {
  return injectedCall(fn, [j(marker.stepId), j(marker.source)]);
}

/** An emitted call, and how the generation gate recognises it in the written test. */
export interface InjectedCall {
  code: string;
  pattern: RegExp;
}

/**
 * A receiver expression: anything up to the argument's comma, allowing one
 * level of parentheses so `await ctx.newPage()` and `page.context().pages()[1]`
 * — how a rewrite names a tab a click opened — count as receivers.
 */
const RECEIVER = String.raw`(?:[^,()]|\([^()]*\))+`;

/**
 * The call as emitted, plus the pattern that accepts it back on any page. The
 * receiver is the one part a rewrite is right to change: a click that opens a
 * new tab has to act on that tab. Everything else is required verbatim, the
 * `await` and `;` included — an unawaited capture races the end of the test,
 * and a mention in a comment is not a call.
 */
function injectedCall(name: string, args: string[]): InjectedCall {
  const tail = args.map(escapeRegExp).join(String.raw`\s*,\s*`);
  return {
    code: `await ${name}(page, ${args.join(", ")});`,
    pattern: new RegExp(String.raw`await\s+${name}\s*\(\s*${RECEIVER}\s*,\s*${tail}\s*,?\s*\)\s*;`),
  };
}

/**
 * The "preserve the step-evidence calls" rule the library-rewrite prompt must
 * carry, built from the same symbol/module constants the emitter injects and
 * the coverage gate greps for — so prompt, emitter, and gate share one truth.
 * A target that captures no step evidence simply doesn't pass this to the
 * engine, and the prompt then omits the rule entirely.
 */
export function stepEvidencePreserveRule(): string {
  return (
    `**Keep the \`${STEP_EVIDENCE_MODULE}\` calls.** The draft's ` +
    `\`await ${STEP_EVIDENCE_BEFORE}(page, ...)\` / \`await ${STEP_EVIDENCE_AFTER}(page, ...)\` lines are ` +
    `load-bearing: ccqa run reads the per-step screenshots they capture. Keep both calls for every ` +
    `step, in place around that step's actions, with their exact \`"<stepId>", "<source>"\` arguments ` +
    `— and keep the import. Pass a different page only when the step genuinely acts on one (a click ` +
    `that opens a new tab). If you move a step's actions into a page-object method, leave ` +
    `these two calls in the test body around the call to that method; do NOT move them inside the ` +
    `page object. Never wrap a step in a closure to hold them.`
  );
}

/**
 * Told to the rewrite because both are conventions the project greps: a
 * missing tag drops the test out of whatever selection runs it, and a missing
 * header loses where the case came from. Neither breaks a run, so nothing else
 * would notice.
 */
export function headerPreserveRule(header: string, titleSuffix: string): string {
  const parts = [
    header ? `the comment block at the top of the draft, verbatim` : "",
    titleSuffix ? `the \`${titleSuffix.trim()}\` suffix on the test's name` : "",
  ].filter(Boolean);
  return `**Keep ${parts.join(" and ")}.** Written from the case's own record, not decided per test; do not reword, move, or drop ${parts.length > 1 ? "either" : "it"}.`;
}

/**
 * Told to the rewrite, because the alternative failure is silent: a claim
 * turned into a text match passes on the wording of one run, which is the
 * assertion the judge exists to replace.
 */
export function judgePreserveRule(): string {
  return (
    `**Keep the \`${JUDGE_MODULE}\` calls.** The draft's \`await ${JUDGE_CALL}(page, "<claim>")\` lines ` +
    `assert a claim a model decides at run time, for output whose wording changes every run. Keep each ` +
    `call where it is, with its claim text unchanged, and keep the import. Do NOT replace one with ` +
    `\`toContainText\`, \`toHaveText\` or any other match on the answer's wording, and do not move it ` +
    `into a page object.`
  );
}

export function emitPlaywrightDraft(input: PlaywrightEmitInput): string {
  const { actions, testName, judgements = [], japanese = false } = input;
  // A target that captures no evidence emits no boundary calls, but the step
  // comments stay: they are how a reviewer reads which step a line belongs to.
  const captures = input.stepEvidence !== false;
  const stepMarkers = input.stepMarkers ?? [];
  const markerByIndex = new Map(stepMarkers.map((m) => [m.actionIndex, m]));

  const lines: string[] = [];
  let prevLine: string | null = null;
  // Mirrors the agent-browser emitter: the open step's closing capture is
  // flushed just before the next step's comment, and once more after the loop.
  let openMarker: StepMarker | null = null;

  // A claim asserts what the steps before it produced, so it is emitted where
  // it sits in the spec: after them, and before whatever the next step does to
  // the page it reads.
  const flushJudgements = (afterActionIndex: number): void => {
    for (const { step } of judgements.filter((j) => j.afterActionIndex === afterActionIndex)) {
      if (openMarker) {
        if (captures) lines.push(stepEvidenceCall(STEP_EVIDENCE_AFTER, openMarker).code);
        openMarker = null;
      }
      if (lines.length > 0) lines.push("");
      lines.push(renderStepComment({ stepId: step.id, source: step.source }, japanese));
      lines.push(judgeCall(step).code);
    }
  };

  const createdAt = creationActionIndex(actions, stepMarkers);
  let createdLine = lines.length;

  flushJudgements(-1);
  for (let i = 0; i < actions.length; i++) {
    openMarker = openStep(lines, markerByIndex.get(i), openMarker, japanese, captures);
    const action = actions[i]!;
    const line = actionToLine(action);
    if (line !== null && line !== prevLine) {
      if (action.replayUnstable) {
        lines.push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
      }
      lines.push(line);
      prevLine = line;
    }
    if (i === createdAt) createdLine = lines.length;
    flushJudgements(i);
  }
  closeStep(lines, openMarker, captures);

  // Nothing coverage-related is emitted: under `--coverage` the run attaches
  // to the browser from outside (see the target's `browserCoverage`), so the
  // generated test carries no measurement code an LLM rewrite could drop.

  const cleanupLines = emitCleanup(input.cleanup, captures, japanese);
  const title = `${testName}${input.titleSuffix ?? ""}`;
  // Only when the route actually created something unique: a declared value
  // nothing reads is an unused variable, and the project's own type check or
  // lint — which this generation is checked against — is right to reject it.
  const usesRunId =
    input.runId !== undefined &&
    [...lines, ...cleanupLines].some((line) => line.includes(RUN_ID_READ));
  const runId = usesRunId ? input.runId : undefined;
  const guarded = runId !== undefined && cleanupLines.length > 0;
  // Spliced before anything is prepended: an index taken during the action
  // loop counts from the loop's own first line, and a later `unshift` would
  // slide the marker above the action that created the thing it marks.
  if (guarded) lines.splice(createdLine, 0, `${CREATED_VAR} = true;`);
  // A claim costs a model round trip, which the default per-test budget was
  // not sized for. Relative to the project's own timeout rather than absolute,
  // so a consumer that already raised it keeps the raise.
  if (judgements.length > 0) lines.unshift("test.slow();", "");
  const testLines = [
    ...(runId ? [`${RUN_ID_VAR} = ${runId.expression};`, ""] : []),
    ...lines,
  ];
  const scoped = cleanupLines.length > 0 || runId !== undefined;
  // A judge call needs Playwright's `testInfo` to attach its verdict to the
  // report; a case with no judgement keeps the plain signature so no unused
  // parameter lands in the generated file.
  const testParams = judgements.length > 0 ? "{ page }, testInfo" : "{ page }";

  // No `test.describe`. One case is one test in one file, so a describe here
  // could only be named after the test it contains — which reads as "X › X"
  // in every report — and the variables it used to scope sit just as well at
  // the top of the file.
  //
  // Declared outside the test so `afterEach` can read them, assigned per
  // attempt so one attempt's value never leaks into the next.
  // `createdSomething` flips where the route created something, so an attempt
  // that failed before that point cleans nothing up.
  const declaration = [
    ...(scoped
      ? [
          ...(runId ? [`let ${RUN_ID_VAR}: string | undefined;`] : []),
          ...(guarded ? [`let ${CREATED_VAR} = false;`] : []),
          "",
        ]
      : []),
    `test(${j(title)}, async (${testParams}) => {`,
    indent(testLines, 2),
    "});",
    ...(cleanupLines.length > 0
      ? [
          "",
          `test.afterEach(${j(cleanupTitle(input.cleanup?.stepMarkers, japanese))}, async ({ page }) => {`,
          ...(guarded ? [`  if (!${CREATED_VAR}) return;`] : []),
          indent(cleanupLines, 2),
          "});",
        ]
      : []),
  ];

  const source = [
    ...(input.header ? [input.header.trimEnd(), ""] : []),
    `import { test, expect } from "@playwright/test";`,
    ...(judgements.length > 0 ? [`import { ${JUDGE_CALL} } from ${j(JUDGE_MODULE)};`] : []),
    // Only imported when there are boundaries to capture, so a marker-less
    // draft doesn't ship an unused import into the consumer's lint run.
    ...(stepMarkers.length > 0 && captures
      ? [
          `import { ${STEP_EVIDENCE_BEFORE}, ${STEP_EVIDENCE_AFTER} } from ${j(STEP_EVIDENCE_MODULE)};`,
        ]
      : []),
    ...(runId ? [runId.import] : []),
    "",
    ...declaration,
    "",
  ].join("\n");

  // The recorded unique value becomes the project's own. A plain replace is
  // exact here: the token is not free text but this emitter's own rendering of
  // one env reference, produced by `envRefsToJsExpression` a few lines above.
  return runId ? source.replaceAll(RUN_ID_READ, RUN_ID_VAR) : source;
}

function indent(lines: string[], by: number): string {
  const pad = " ".repeat(by);
  return lines.map((l) => (l === "" ? "" : `${pad}${l}`)).join("\n");
}

/**
 * The recorded undo actions, with their step comments. Emitted from the
 * recording like everything else: what the cleanup does was demonstrated in
 * the browser, not guessed from the case's prose.
 */
function emitCleanup(
  cleanup: PlaywrightEmitInput["cleanup"],
  captures: boolean,
  japanese: boolean,
): string[] {
  if (!cleanup || cleanup.actions.length === 0) return [];
  const lines: string[] = [];
  const markerByIndex = new Map((cleanup.stepMarkers ?? []).map((m) => [m.actionIndex, m]));
  let open: StepMarker | null = null;
  for (let i = 0; i < cleanup.actions.length; i++) {
    open = openStep(lines, markerByIndex.get(i), open, japanese, captures);
    const action = cleanup.actions[i]!;
    if (action.replayUnstable) {
      lines.push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
    }
    const line = actionToLine(action);
    if (line !== null) lines.push(line);
  }
  closeStep(lines, open, captures);
  return lines;
}

/**
 * Enter the step a marker starts: close the one before it, comment the
 * boundary, and open the capture. Shared by the two places that walk an action
 * list against markers, so a change to how a boundary is written cannot apply
 * to the steps and miss the cleanup.
 */
function openStep(
  lines: string[],
  marker: StepMarker | undefined,
  open: StepMarker | null,
  japanese: boolean,
  captures: boolean,
): StepMarker | null {
  if (!marker) return open;
  if (open && captures) lines.push(stepEvidenceCall(STEP_EVIDENCE_AFTER, open).code);
  if (lines.length > 0) lines.push("");
  lines.push(renderStepComment(marker, japanese));
  if (captures) lines.push(stepEvidenceCall(STEP_EVIDENCE_BEFORE, marker).code);
  return marker;
}

/** Close the step still open at the end of an action list. */
function closeStep(lines: string[], open: StepMarker | null, captures: boolean): void {
  if (open && captures) lines.push(stepEvidenceCall(STEP_EVIDENCE_AFTER, open).code);
}

/**
 * Render a locator (plus positional pick) as a Playwright locator expression.
 * Semantic strategies map 1:1 onto the getBy* family; `by: "css"` keeps its
 * raw selector-engine string (locator() accepts `text=...` forms verbatim).
 * Every locator value — css included — goes through `jExpr`, so a `${VAR}` /
 * `$VAR` ref in a recorded selector expands to a `process.env` template
 * literal instead of baking the literal ref text into the selector.
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
      expr = `page.locator(${jExpr(locator.value)})`;
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

  // Same rule again: a wait the validator watched fail is a failure condition,
  // not a synchronisation point — the next run that legitimately lacks the text
  // stops here, before any assert runs. Playwright's own assertions wait, so
  // dropping it costs no settling time. A cascade-skipped wait was never
  // attempted and keeps its line.
  if (
    action.action === "wait" &&
    action.replayUnstable === true &&
    !(action.replayReason ?? "").includes("skipped after a preceding action failed")
  ) {
    const sel = action.locator?.value ?? "(unknown)";
    return `// [warn] replay-unstable: dropped wait (${sel}) — did not resolve on replay`;
  }

  const locator = action.locator ? locatorToPlaywright(action.locator, action.index) : null;
  // agent-browser acts on the first element its locator matches. `.first()` keeps
  // that semantic under Playwright's strict mode, which fails the whole step when
  // several match (unless an explicit index pick already narrowed it).
  const subject = locator !== null && action.index === undefined ? `${locator}.first()` : locator;

  switch (action.action) {
    case "navigate":
      return `await page.goto(${jExpr(action.value ?? "")});`;
    case "click":
      return subject ? `await ${subject}.click();` : droppedActionMarker(action);
    case "dblclick":
      return subject ? `await ${subject}.dblclick();` : droppedActionMarker(action);
    case "fill":
    case "type":
      // `type` is ccqa's alias of `fill` (same as the agent-browser mapping).
      return subject
        ? `await ${subject}.fill(${jExpr(action.value ?? "")});`
        : droppedActionMarker(action);
    case "press":
      return subject
        ? `await ${subject}.press(${jExpr(action.value ?? "")});`
        : `await page.keyboard.press(${jExpr(action.value ?? "")});`;
    case "check":
      return subject ? `await ${subject}.check();` : droppedActionMarker(action);
    case "uncheck":
      return subject ? `await ${subject}.uncheck();` : droppedActionMarker(action);
    case "select":
      return subject
        ? `await ${subject}.selectOption(${jExpr(action.value ?? "")});`
        : droppedActionMarker(action);
    case "hover":
      return subject ? `await ${subject}.hover();` : droppedActionMarker(action);
    case "focus":
      return subject ? `await ${subject}.focus();` : droppedActionMarker(action);
    case "drag": {
      if (!subject || !action.target) return droppedActionMarker(action);
      return `await ${subject}.dragTo(${locatorToPlaywright(action.target)}.first());`;
    }
    case "upload": {
      const files = action.files ?? [];
      if (!subject || files.length === 0) return droppedActionMarker(action);
      return `await ${subject}.setInputFiles([${files.map(jExpr).join(", ")}]);`;
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
  const px = action.pixels
    ? parseInt(action.pixels, 10) || DEFAULT_SCROLL_PIXELS
    : DEFAULT_SCROLL_PIXELS;
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

/**
 * What the undo is called in the report. The case's own first cleanup
 * sentence where it has one — a hook named for what it takes back is the one
 * thing a reader of a failing report needs from it.
 */
function cleanupTitle(cleanup: readonly StepMarker[] | undefined, japanese: boolean): string {
  const first = cleanup?.find((m) => m.text?.trim())?.text?.trim().split("\n")[0]?.trim();
  if (first) return first;
  return japanese ? "後処理" : "clean up what the test created";
}

function assertToLine(action: RecordedAction, locator: string | null): string | null {
  // Like the agent-browser emitter: the LLM may put the expectation text in
  // `observation` instead of `value`.
  const value = action.value ?? action.observation;
  const comment = action.observation ? `// Assert: ${action.observation}` : null;
  // No `.first()` here, unlike the actions above.
  //
  // The probe these come from answers "at least one such element", and
  // narrowing to the first match reproduces that faithfully — while asserting
  // almost nothing: it holds wherever the string appears, including on the
  // element the case did not mean. Strict mode failing on an ambiguous
  // locator is the more useful outcome, because it says which locator needs
  // scoping and the fix pass can scope it. An explicit index pick is a
  // decision the recording made and stays.
  const pick = action.index === undefined ? "" : "";

  let assertLine: string | null = null;
  switch (action.assert) {
    case "text_visible":
      if (value) assertLine = `await expect(page.getByText(${jExpr(value)})).toBeVisible();`;
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
 * `url_contains` → "the URL contains this".
 *
 * A `${VAR}` only has a value at run time, which rules out both forms that take
 * the pattern up front: a regular expression would have to match the reference
 * span with `.*` (so `${APP_BASE_URL}` alone would assert nothing at all), and
 * the glob `toHaveURL` accepts is compared against the whole URL, so an
 * absolute one never matches. Polling `page.url()` keeps the substring
 * semantic and the resolved value.
 */
function urlContainsAssert(value: string): string {
  const expr = jExpr(value);
  if (expr.startsWith("`")) {
    return `await expect.poll(() => page.url()).toContain(${expr});`;
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

/**
 * One claim, asserted through the judge. Exported so the generation gate can
 * require it back. `testInfo` is always passed — the case's `test(...)`
 * callback is emitted with that second parameter whenever it has a judgement
 * — so the verdict lands on the report whether the claim held or not.
 */
export function judgeCall(step: ExpandedJudgeByLlmStep): InjectedCall {
  // A claim is prose, so only the braced form is a reference here — a bare
  // `$WORD` is a word, and expanding it would quietly rewrite the claim.
  const args = [bracedRefsToJsExpression(step.judgeByLlm.trim())];
  const optionsFields = step.from !== undefined ? [`from: ${jExpr(step.from)}`, "testInfo"] : ["testInfo"];
  args.push(`{ ${optionsFields.join(", ")} }`);
  return injectedCall(JUDGE_CALL, args);
}
