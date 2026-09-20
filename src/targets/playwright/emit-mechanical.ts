import type { ExpandedJudgeByLlmStep } from "../../spec/expand.ts";
import { bracedRefsToJsExpression, envRefsToJsExpression } from "../../runtime/env-vars.ts";
import type { Locator, LocatorIndex, RecordedAction } from "../../ir/types.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";
import { renderStepLabel } from "../../codegen/step-comment.ts";

/**
 * Deterministic IR → plain `@playwright/test` emitter — no LLM involved.
 * Produces the "mechanical draft": a 1:1 compilation of the recorded route
 * that the library-reuse LLM pass treats as ground truth (or that ships
 * as-is when no resources are configured).
 *
 * Each of the case's steps is emitted as a native `test.step(...)` block
 * titled with the same label the agent-browser emitter writes as a comment,
 * so the file a project commits is plain `@playwright/test` with nothing of
 * ccqa's in it. The rest follows that emitter too: `// [warn]
 * replay-unstable: ...` breadcrumbs, observation-only snapshots as comments,
 * and env refs (`$VAR` / `${VAR}`) in user-supplied values emitted as
 * `process.env.VAR ?? ""` template literals so secrets never bake into the
 * script.
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
  /** False: the undo is emitted as actions only (config `allowExpectInCleanup`). */
  allowExpectInCleanup?: boolean;
  /**
   * How the project names the unique values a run creates. Given, the recorded
   * `${CCQA_RUN_ID}` is emitted as a call to it, evaluated once per attempt —
   * so the generated test carries the project's own convention rather than an
   * environment variable ccqa happens to set.
   */
  runId?: { import: string; expression: string };
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
 * A fill the very next action overwrites.
 *
 * `fill` replaces a field's contents, so two in a row on the same element
 * leave only the second — the first was never on screen for anything to
 * observe. It happens when the recording agent types a value, sees it is
 * wrong, and types again: both keystrokes really happened, which is why the
 * recording keeps them, but only one of them was ever state. Answered here
 * rather than at record time so a case already recorded need not be recorded
 * again, and so the route keeps the honest account of what was typed.
 *
 * Adjacent only, and never across a step boundary: anything in between makes
 * the first value observable, and then it is part of what the case does.
 * `type` appends rather than replaces, so it is left alone.
 */
function overwrittenByNext(a: RecordedAction, b: RecordedAction | undefined): boolean {
  if (!b || a.action !== "fill" || b.action !== "fill") return false;
  if ((a.stepId ?? "") !== (b.stepId ?? "")) return false;
  if (a.secret || b.secret) return false;
  return JSON.stringify([a.locator, a.index]) === JSON.stringify([b.locator, b.index]);
}

/** Observation only: these decide what happened, they do not make it happen. */
const OBSERVING_ACTIONS = new Set<RecordedAction["action"]>(["assert", "snapshot", "wait"]);

/**
 * The action after which the route has created the thing the cleanup undoes.
 *
 * Mechanical, so a reader can predict it: the first action that submits
 * (a click, a double click, a key press) after the first one that typed the
 * run's unique value — and then the end of that action's step, since what the
 * step does is one act. A route that types the value and never submits it, or
 * never types it at all, has no such moment, so the last action stands in:
 * assigning at the end is still later than the creation, and never earlier.
 *
 * The step's own checks are not part of the act. The flag answers whether the
 * route created the thing, and that is settled when the acting stops, not when
 * the checking passes — put it after an assertion and a run whose creation
 * succeeded but whose check failed skips its own undo, leaving what it made in
 * the environment. That is the run the undo exists for.
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
  let end = next ? next.actionIndex - 1 : last;
  while (end > submitted && OBSERVING_ACTIONS.has(actions[end]!.action)) end -= 1;
  return end;
}

/** A claim and the action index it is asserted after (-1: before any action). */
export interface Judgement {
  step: ExpandedJudgeByLlmStep;
  afterActionIndex: number;
}

/** Module the emitted judge calls import from, and the call they make. */
export const JUDGE_MODULE = "ccqa/judge";
export const JUDGE_CALL = "judgeByLlm";

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
 * Told to the rewrite, because the alternative failure is silent in the worst
 * way: nothing breaks at run time, and the file's assertions simply stop
 * belonging to any step. A rewrite that reshapes the line learns that only by
 * rejection, which costs a whole round.
 */
export function stepCommentPreserveRule(): string {
  return (
    "**Keep every `test.step(...)` block, with its title exactly as the draft wrote it.** Those " +
    "titles are how the evidence table, the run's per-step screenshots and the review of this test " +
    "say which assertions belong to which step. A reshaped one parses as no step at all, and every " +
    "step then reads as deciding nothing. Keep the wording, the numbering and the punctuation, and " +
    "keep each step's actions inside its own block — a step's call to a page-object method belongs " +
    "in the block, not outside it. Do not merge, split or reorder the blocks. A test already at " +
    "this path may have been written by an older ccqa in a different shape: the draft is what this " +
    "file must look like, not that one."
  );
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
  const stepMarkers = input.stepMarkers ?? [];
  const markerByIndex = new Map(stepMarkers.map((m) => [m.actionIndex, m]));

  const body: Body = [];
  let prevLine: string | null = null;
  // The block a line lands in. Pushed into `body` when the step opens and
  // filled afterwards, so the array that holds a step's lines stays reachable
  // until the whole test is rendered — which is what lets the creation flag be
  // spliced into the middle of a step once the loop knows it is needed.
  let open: Body | null = null;
  const target = (): Body => open ?? body;
  const openStep = (marker: StepMarker | undefined): void => {
    if (!marker) return;
    open = openBlock(body, marker, japanese);
  };

  // A claim asserts what the steps before it produced, so it is emitted where
  // it sits in the spec: after them, and before whatever the next step does to
  // the page it reads.
  const flushJudgements = (afterActionIndex: number): void => {
    for (const { step } of judgements.filter((j) => j.afterActionIndex === afterActionIndex)) {
      const block = openBlock(body, { stepId: step.id, source: step.source }, japanese);
      block.push(judgeCall(step).code);
      // The claim closes whatever step was open: what follows it belongs to
      // the next step of the case, not to the one this claim reads.
      open = null;
    }
  };

  const creationIndex = creationActionIndex(actions, stepMarkers);
  let createdAt: { block: Body; index: number } = { block: body, index: 0 };

  flushJudgements(-1);
  for (let i = 0; i < actions.length; i++) {
    openStep(markerByIndex.get(i));
    const action = actions[i]!;
    if (overwrittenByNext(action, actions[i + 1])) continue;
    const line = actionToLine(action, japanese);
    if (line !== null && line !== prevLine) {
      if (action.replayUnstable) {
        target().push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
      }
      target().push(...line.split("\n"));
      prevLine = line;
    }
    if (i === creationIndex) createdAt = { block: target(), index: target().length };
    flushJudgements(i);
  }

  // Nothing coverage-related is emitted: under `--coverage` the run attaches
  // to the browser from outside (see the target's `browserCoverage`), so the
  // generated test carries no measurement code an LLM rewrite could drop.

  const cleanupBody = emitCleanup(input.cleanup, japanese, input.allowExpectInCleanup ?? true);
  const title = `${testName}${input.titleSuffix ?? ""}`;
  // Only when the route actually created something unique: a declared value
  // nothing reads is an unused variable, and the project's own type check or
  // lint — which this generation is checked against — is right to reject it.
  const usesRunId =
    input.runId !== undefined &&
    [...codeLines(body), ...codeLines(cleanupBody)].some((line) => line.includes(RUN_ID_READ));
  const runId = usesRunId ? input.runId : undefined;
  const guarded = runId !== undefined && cleanupBody.length > 0;
  // Spliced before anything is prepended: an index taken during the action
  // loop counts from the loop's own first line, and a later `unshift` would
  // slide the marker above the action that created the thing it marks.
  if (guarded) createdAt.block.splice(createdAt.index, 0, `${CREATED_VAR} = true;`);
  // A claim costs a model round trip, which the default per-test budget was
  // not sized for. Relative to the project's own timeout rather than absolute,
  // so a consumer that already raised it keeps the raise.
  if (judgements.length > 0) body.unshift("test.slow();", "");
  const testLines: Body = [
    ...(runId ? [`${RUN_ID_VAR} = ${runId.expression};`, ""] : []),
    ...body,
  ];
  const scoped = cleanupBody.length > 0 || runId !== undefined;
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
    ...renderBody(testLines, 2),
    "});",
    ...(cleanupBody.length > 0
      ? [
          "",
          `test.afterEach(${j(cleanupTitle(input.cleanup?.stepMarkers, japanese))}, async ({ page }) => {`,
          ...(guarded ? [`  if (!${CREATED_VAR}) return;`] : []),
          ...renderBody(cleanupBody, 2),
          "});",
        ]
      : []),
  ];

  const source = [
    ...(input.header ? [input.header.trimEnd(), ""] : []),
    `import { test, expect } from "@playwright/test";`,
    ...(judgements.length > 0 ? [`import { ${JUDGE_CALL} } from ${j(JUDGE_MODULE)};`] : []),
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

/**
 * The test's body as a tree: plain lines, and the `test.step` blocks that hold
 * a step's own. A tree rather than a flat list of pre-indented strings because
 * the emitter has to reach back into a step after it has closed — the creation
 * flag is placed mid-step by a decision only the end of the walk can make.
 */
type Body = (string | StepBlock)[];
interface StepBlock {
  title: string;
  body: Body;
}

/**
 * Open a step's block at the end of `body` and return the array its lines go
 * in. Shared by the two places that walk an action list against markers, so a
 * change to how a boundary is written cannot apply to the steps and miss the
 * cleanup.
 */
function openBlock(
  body: Body,
  marker: Pick<StepMarker, "stepId" | "source" | "text">,
  japanese: boolean,
): Body {
  if (body.length > 0) body.push("");
  const block: StepBlock = { title: renderStepLabel(marker, japanese), body: [] };
  body.push(block);
  return block.body;
}

function renderBody(body: Body, by: number): string[] {
  const pad = " ".repeat(by);
  const out: string[] = [];
  for (const node of body) {
    if (typeof node === "string") {
      out.push(node === "" ? "" : `${pad}${node}`);
      continue;
    }
    out.push(`${pad}await test.step(${j(node.title)}, async () => {`);
    out.push(...renderBody(node.body, by + 2));
    out.push(`${pad}});`);
  }
  return out;
}

/** Every code line the body holds, step blocks included. */
function codeLines(body: Body): string[] {
  return body.flatMap((node) => (typeof node === "string" ? [node] : codeLines(node.body)));
}

/**
 * The recorded undo actions, with their step comments. Emitted from the
 * recording like everything else: what the cleanup does was demonstrated in
 * the browser, not guessed from the case's prose.
 */
function emitCleanup(
  cleanup: PlaywrightEmitInput["cleanup"],
  japanese: boolean,
  allowExpect: boolean,
): Body {
  if (!cleanup || cleanup.actions.length === 0) return [];
  const body: Body = [];
  const markerByIndex = new Map((cleanup.stepMarkers ?? []).map((m) => [m.actionIndex, m]));
  let open: Body | null = null;
  const target = (): Body => open ?? body;
  for (let i = 0; i < cleanup.actions.length; i++) {
    const marker = markerByIndex.get(i);
    if (marker) open = openBlock(body, marker, japanese);
    const action = cleanup.actions[i]!;
    // A project that forbids `expect` in its teardown gets the undo's actions
    // and nothing else. What the recorded check was for is not lost — the
    // evidence table reports the cleanup expectation as unchecked.
    if (!allowExpect && action.action === "assert") continue;
    if (overwrittenByNext(action, cleanup.actions[i + 1])) continue;
    if (action.replayUnstable) {
      target().push(`// [warn] replay-unstable: ${action.replayReason ?? "(no reason recorded)"}`);
    }
    const line = actionToLine(action, japanese);
    if (line !== null) target().push(...line.split("\n"));
  }
  return body;
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

function actionToLine(action: RecordedAction, japanese = false): string | null {
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
      return assertToLine(action, locator, japanese);
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

function assertToLine(
  action: RecordedAction,
  locator: string | null,
  japanese: boolean,
): string | null {
  // Like the agent-browser emitter: the LLM may put the expectation text in
  // `observation` instead of `value`.
  const value = action.value ?? action.observation;
  // The label as well as the note: a file whose steps read in one language
  // and whose assertions are introduced in another is one nobody skims.
  const comment = action.observation
    ? `// ${japanese ? "期待値" : "Assert"}: ${action.observation}`
    : null;
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
  if (comment && assertLine) return `${comment}\n${assertLine}`;
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
  return `// [warn] action dropped: ${action.action}${ctx} — the recording is missing its locator. Re-run \`ccqa record\` to regenerate.`;
}

/** JSON.stringify — a quoted string literal safe for embedding in TS source. */
const j = (s: string): string => JSON.stringify(s);

/**
 * Like `j`, but `$VAR` / `${VAR}` refs become `process.env.VAR ?? ""`
 * template-literal substitutions (same transform the agent-browser emitter
 * applies to user-supplied values).
 */
const jExpr = (s: string): string => envRefsToJsExpression(s);

/** The emitted judge call, and how the generation gate recognises it back. */
export interface JudgeCall {
  code: string;
  pattern: RegExp;
}

/**
 * One claim, asserted through the judge. Exported so the generation gate can
 * require it back. `testInfo` is always passed — the case's `test(...)`
 * callback is emitted with that second parameter whenever it has a judgement
 * — so the verdict lands on the report whether the claim held or not.
 *
 * The pattern accepts the call on any page: the receiver is the one part a
 * rewrite is right to change, because a click that opens a new tab has to be
 * judged on that tab. It allows one level of parentheses so `await
 * ctx.newPage()` and `page.context().pages()[1]` count as receivers.
 * Everything else is required verbatim, the `await` and `;` included — an
 * unawaited claim races the end of the test, and a mention in a comment is not
 * a call.
 */
export function judgeCall(step: ExpandedJudgeByLlmStep): JudgeCall {
  // A claim is prose, so only the braced form is a reference here — a bare
  // `$WORD` is a word, and expanding it would quietly rewrite the claim.
  const args = [bracedRefsToJsExpression(step.judgeByLlm.trim())];
  const optionsFields = step.from !== undefined ? [`from: ${jExpr(step.from)}`, "testInfo"] : ["testInfo"];
  args.push(`{ ${optionsFields.join(", ")} }`);
  const receiver = String.raw`(?:[^,()]|\([^()]*\))+`;
  const tail = args.map(escapeRegExp).join(String.raw`\s*,\s*`);
  return {
    code: `await ${JUDGE_CALL}(page, ${args.join(", ")});`,
    pattern: new RegExp(
      String.raw`await\s+${JUDGE_CALL}\s*\(\s*${receiver}\s*,\s*${tail}\s*,?\s*\)\s*;`,
    ),
  };
}
