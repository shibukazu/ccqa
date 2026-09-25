import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { saveSpecReview, SPEC_DIR_TEMPLATE, TEST_SCRIPT_FILE } from "../../store/index.ts";
import { renderHeader, renderTitleTag } from "../external/header.ts";
import {
  expandSpec,
  isExpandedActionStep,
  isExpandedJudgeByLlmStep,
  type ExpandedStep,
} from "../../spec/expand.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";
import { parseStepBlock, stepLines } from "../../codegen/step-comment.ts";
import type { RecordedAction } from "../../types.ts";
import { playwrightTaskInstructions } from "../../prompts/llm-gen.ts";
import { buildStepMarkers, lastActionIndexPerStep } from "../agent-browser/generate.ts";
import { collectSupportFiles, exportedNames, importedSpecifiers } from "../support-files.ts";
import {
  finalizePreparedFiles,
  generateWithLlmEngine,
  type LlmGeneratedFile,
  type Reading,
} from "../llm-engine.ts";
import {
  emitPlaywrightDraft,
  headerPreserveRule,
  judgeCall,
  JUDGE_CALL,
  JUDGE_MODULE,
  type Judgement,
  judgePreserveRule,
  stepCommentPreserveRule,
} from "./emit-mechanical.ts";
import { acquirePlaywrightBrowser } from "./browser-server.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import {
  resolveStepEvidence,
  type GenerateContext,
  type GenerateResult,
  type StepEvidenceSupport,
  type TargetPlugin,
} from "../types.ts";
import * as log from "../../cli/logger.ts";
import { useJapanesePrompts } from "../../prompts/language.ts";
import { reviewGeneratedTest } from "../verifies-spec.ts";

const PLAYWRIGHT_TARGET = "playwright";

/**
 * The Playwright target (input: "recording"): `ccqa record` traces the spec
 * into ir.json, and generate compiles that recording in two stages —
 *
 *   1. mechanical emit: IR → plain `@playwright/test` code (deterministic);
 *   2. when `resources` are configured, an LLM pass rewrites the draft into
 *      the repo's library-reusing shape (page objects / helpers / shared
 *      constants), treating the draft as recorded ground truth.
 *
 * Without resources the draft ships as-is; both paths share the engine's
 * write + runCommand verification loop.
 */
export const playwrightTarget: TargetPlugin = {
  id: PLAYWRIGHT_TARGET,
  input: "recording",
  generate: generatePlaywrightTest,
  // Beside the spec by default, like the agent-browser target: a project that
  // configures nothing still gets one runnable test per spec directory. A repo
  // with its own layout sets `targets.playwright.testPath`.
  defaultTestPath: `${SPEC_DIR_TEMPLATE}/${TEST_SCRIPT_FILE}`,
  runner: runCommandRunner,
  // The generated test carries no capture code. `ccqa run` asks Playwright for
  // a trace instead and recovers the same per-step before/after screenshots
  // agent-browser produces from it — see `trace-capture.ts`. Whether a run
  // takes them is the project's setting, ANDed in by `resolveStepEvidence`.
  stepEvidence: { supported: true },
  judgeSteps: { supported: true },
  // `playwright test` launches its browser inside a process ccqa does not own,
  // so ccqa launches the browser instead and a generated config wrapper makes
  // the tests connect to it. Nothing is emitted into the tests themselves.
  browserCoverage: { browser: "cdp", cdpEndpoint: acquirePlaywrightBrowser },
  guidanceKind: PLAYWRIGHT_TARGET,
};

async function generatePlaywrightTest(ctx: GenerateContext): Promise<GenerateResult> {
  if (!ctx.recording) {
    throw new Error(
      `the playwright target needs a recording — run \`ccqa record ${ctx.featureName}/${ctx.specName}\` first`,
    );
  }
  if (ctx.targetConfig.testPath === undefined) {
    // The default lands the Playwright test at the spec dir's `test.spec.ts` —
    // the exact path the agent-browser deterministic runner treats as its
    // vitest recording. Running the spec later could then pick the wrong
    // runner. Recommend a testPath, but don't hard-fail: existing
    // single-target playwright projects rely on this default.
    log.warn(
      `no \`testPath\` configured for the playwright target — writing ${ctx.testPath}, the same path the ` +
        `agent-browser target uses for its vitest test. Set \`targets.playwright.testPath\` in ` +
        `.ccqa/config.yaml (e.g. \`e2e/specs/{feature}/{spec}.spec.ts\`) to keep them apart.`,
    );
  }
  return compileRecording(
    ctx,
    PLAYWRIGHT_TARGET,
    resolveStepEvidence(playwrightTarget, ctx.targetConfig),
  );
}

/**
 * IR → a `@playwright/test` file, for every target whose tests are Playwright's.
 *
 * The built-in `playwright` target and a project-defined `kind: external` one
 * differ in configuration, not in how a recording becomes code: the same
 * mechanical emit, the same reuse-first rewrite when resources are declared,
 * the same gates over what the rewrite may drop. Sharing the pipeline is what
 * keeps those gates from applying to one target and not the other — the way a
 * second copy always eventually does.
 *
 * `stepEvidence` comes from the target that entered the pipeline, already
 * resolved against the project's config: the two targets differ in which
 * plugin answers, and only they know which one it is.
 */
export async function compileRecording(
  ctx: GenerateContext,
  guidanceKind: "playwright",
  stepEvidence: StepEvidenceSupport,
): Promise<GenerateResult> {
  const actions = ctx.recording!;
  // Steps arrive expanded: whichever document stated the case, resolving it
  // did that work, and doing it again here would be a second reading of the
  // same file with a chance of disagreeing.
  const expanded = ctx.steps;
  const cleanup = ctx.cleanup.filter(isExpandedActionStep);
  // A judge step records no actions, so it has no marker to place. Its call is
  // emitted into the draft instead, which is what keeps a claim from depending
  // on a rewrite choosing to keep it.
  const stepMarkers = buildStepMarkers(expanded.filter(isExpandedActionStep), actions);
  const cleanupMarkers = buildStepMarkers(cleanup, ctx.cleanupRecording ?? []);
  // A step with no marker recorded no action under its own id, so the emitter
  // writes no boundary for it: no `test.step` block, no screenshots, and
  // nothing for the injected-call gate to check. Named here because everything
  // downstream then looks like a case that simply had fewer steps.
  const unattributed = expanded
    .filter(isExpandedActionStep)
    .map((s) => s.id)
    .filter((id) => !stepMarkers.some((m) => m.stepId === id));
  if (unattributed.length > 0) {
    log.warn(
      `no recorded action belongs to ${unattributed.join(", ")} — the generated test has no ` +
        `boundary for ${unattributed.length > 1 ? "those steps" : "that step"}, so it captures no ` +
        `screenshots there and the evidence table shows nothing. Re-record the case.`,
    );
  }
  const { judgements, warnings: judgeWarnings } = placeJudgements(expanded, actions, ctx.ref.id);
  for (const w of judgeWarnings) log.warn(w);

  const header = ctx.targetConfig.header ? renderHeader(ctx.targetConfig.header, ctx.fields) : "";
  const titleSuffix = renderTitleTag(ctx.targetConfig.titleTags, ctx.fields);
  const draft = emitPlaywrightDraft({
    actions,
    testName: ctx.spec.title,
    stepMarkers,
    judgements,
    ...(header ? { header } : {}),
    titleSuffix,
    ...(ctx.cleanupRecording && ctx.cleanupRecording.length > 0
      ? { cleanup: { actions: ctx.cleanupRecording, stepMarkers: cleanupMarkers } }
      : {}),
    ...(ctx.targetConfig.runId ? { runId: ctx.targetConfig.runId } : {}),
    allowExpectInCleanup: ctx.targetConfig.allowExpectInCleanup,
    japanese: useJapanesePrompts(ctx.language),
  });

  log.meta("actions", actions.length);
  log.meta(
    "mode",
    ctx.resources.length > 0 ? "mechanical emit + library rewrite" : "mechanical emit",
  );
  log.blank();

  // What the rewrite may not drop. Only what the draft actually carries: a
  // rule about something that is not there reads as an instruction to add it.
  const invariants = [
    stepMarkers.length > 0 || cleanupMarkers.length > 0 ? stepCommentPreserveRule() : "",
    judgements.length > 0 ? judgePreserveRule() : "",
    header || titleSuffix ? headerPreserveRule(header, titleSuffix) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const injected: InjectedCallSpec = {
    markers: [...stepMarkers, ...cleanupMarkers],
    judgements,
    header,
    titleSuffix,
  };
  // The same gate the written file is checked against, applied to the reply
  // before it is written — so a rewrite that dissolved a step's block is asked
  // again instead of shipping a spec whose steps nothing can attribute. A
  // support file is held to the import rule as well: a page object that loads
  // ccqa breaks the project's build exactly as the test would.
  const validateFile = (file: { contents: string; kind: "test" | "support" }): string | null => {
    const gaps =
      file.kind === "test"
        ? injectedCallGaps(file.contents, injected)
        : runtimeImportGaps(file.contents);
    return gaps.length === 0 ? null : gaps.join("; ");
  };

  // The loop's own bar is "does it go green", and a rewrite that weakens an
  // assertion clears it as easily as one that keeps it. This is the pass that
  // asks the other questions, and it is told what the test leans on — written
  // this run or reused — because an assertion is only as strong as the locator
  // it names, and the locator is not in the test file.
  const reading: Reading = async (files, guides, askModel) =>
    reviewGeneratedTest({
      files,
      askModel,
      leansOn: await leanedOn(files, ctx.cwd, ctx.testPath),
      guides,
      steps: expanded,
      ...(ctx.expectations.length > 0 ? { expectations: ctx.expectations } : {}),
      // The cleanup joins the reading only when the case says what its undo
      // must make true, and only when this project lets the undo check it. A
      // reading asked about assertions the config forbids would demand them
      // every round, and every round would be spent refusing.
      ...(ctx.cleanupExpectations.length > 0 && ctx.targetConfig.allowExpectInCleanup
        ? { cleanup }
        : {}),
      language: ctx.language,
      ...(ctx.model ? { model: ctx.model } : {}),
      cwd: ctx.cwd,
    });

  const result =
    ctx.resources.length > 0
      ? await generateWithLlmEngine({
          ctx,
          target: guidanceKind,
          steps: expanded,
          taskInstructions: playwrightTaskInstructions(ctx.testPath),
          draft: { path: ctx.testPath, contents: draft },
          ...(invariants ? { draftInvariant: invariants } : {}),
          stepEvidence,
          validateFile,
          reading,
        })
      : await finalizePreparedFiles({
          ctx,
          target: guidanceKind,
          files: [{ path: ctx.testPath, contents: draft, kind: "test" }],
          summary: `test compiled from ${actions.length} recorded action(s)`,
          warnings: [],
          stepEvidence,
          validateFile,
          reading,
        });

  const written = (await readCorpus(result, "test")).join("\n");
  const missing = injectedCallGaps(written, injected);
  for (const w of missing) log.warn(w);
  // Logged, not carried into `warnings`: this is an observation about files
  // just written, and a page object shared with another case is not a defect
  // the report and the hub should be told about.
  for (const w of await unusedSupportExports(result, written, ctx.cwd)) log.warn(w);
  // Obtained inside the verification loop, where a finding can still spend a
  // fix round instead of only reaching a human. Kept here because the record
  // of what the case was checked against belongs to the case, not to a loop.
  const review = result.review;
  await saveSpecReview(ctx.ref, review ?? { findings: null, complete: false, warnings: [] });
  return {
    ...result,
    warnings: [...result.warnings, ...judgeWarnings, ...missing, ...(review?.warnings ?? [])],
  };
}

/**
 * The written files of one kind. Read from disk rather than taken from the
 * reply: the LLM pass may have relocated them, and a file that cannot be read
 * reads as empty so a gate reports everything missing rather than passing
 * silently.
 */
async function readCorpus(result: GenerateResult, kind: "test" | "support"): Promise<string[]> {
  return Promise.all(
    result.files.filter((f) => f.kind === kind).map((f) => readFile(f.path, "utf8").catch(() => "")),
  );
}

/**
 * Exports of a support file ccqa wrote that nothing else it wrote mentions.
 *
 * A re-record can stop using an element a page object still defines, and the
 * page object is not rewritten — it keeps a definition nothing here reaches.
 * Said, not removed: a page object exists to be shared, and only the project
 * knows whether another case still uses it.
 */
async function unusedSupportExports(
  result: GenerateResult,
  written: string,
  cwd: string,
): Promise<string[]> {
  const supports = result.files.filter((f) => f.kind === "support");
  if (supports.length === 0 || written === "") return [];
  const supportSources = await readCorpus(result, "support");
  const warnings: string[] = [];
  for (const [i, support] of supports.entries()) {
    const source = supportSources[i]!;
    if (source === "") continue;
    // The test plus every *other* support file: one page object importing
    // another's export is a use, and its own source is where it is declared.
    // Tokenised rather than a regex per name — `$`-prefixed identifiers are
    // legal and `\b` cannot match them, which would report them all unused.
    const others = [written, ...supportSources.filter((_, j) => j !== i)].join("\n");
    const mentioned = new Set(others.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const unused = exportedNames(source).filter((name) => !mentioned.has(name));
    if (unused.length === 0) continue;
    warnings.push(
      `${relative(cwd, support.path)}: nothing generated for this case uses ${unused.join(", ")} — ` +
        `if no other case does either, an earlier recording left the definition behind.`,
    );
  }
  return warnings;
}

/**
 * What the written test reaches by importing it, and this generation did not
 * write — the half nobody re-reads. A page object this case reuses was written
 * under whatever the project's rules were at the time, it is imported
 * verbatim, and the locators in it decide as much of this case as the ones in
 * the test file do. Followed from the imports, because that is how the code
 * itself finds them.
 *
 * Paths only: the review opens what it decides to open, so listing a file
 * costs nothing and there is no budget to spend.
 */
export async function leanedOn(
  files: readonly LlmGeneratedFile[],
  cwd: string,
  testPath: string,
): Promise<string[]> {
  const written = new Set(files.map((f) => resolve(cwd, f.path)));
  return (await collectSupportFiles(resolve(cwd, testPath), cwd))
    // An unreadable file is a path the review can only waste a turn on.
    .filter((file) => !written.has(file.abs) && file.source !== "")
    .map((file) => relative(cwd, file.abs));
}

/** What the emitter injected and the written test must still carry. */
export interface InjectedCallSpec {
  /** Every step the draft opened with a `test.step` block — cleanup steps included. */
  markers: StepMarker[];
  judgements: Judgement[];
  header: string;
  titleSuffix: string;
}

/**
 * The injected calls and stamped conventions `corpus` no longer has.
 *
 * Asked twice, of the same source: once of the reply, before it is written,
 * so a rewrite that dropped one is rejected and asked again; once of the file
 * on disk, so the deterministic path and a declined fix are covered too. One
 * function, because a gate that answered differently in the two moments would
 * be worse than either alone.
 */
export function injectedCallGaps(
  corpus: string,
  { markers, judgements, header, titleSuffix }: InjectedCallSpec,
): string[] {
  const warnings: string[] = [...runtimeImportGaps(corpus)];
  const stamped = { header, titleSuffix };
  // Only the block form counts here, though attribution reads the older
  // comment form too. The rewrite pass has the repository open and imitates
  // what it finds at the test's own path — so a spec generated by an earlier
  // ccqa is a live template for the shape this gate exists to stop, and a gate
  // that accepted both would never say so.
  const titled = new Set(
    stepLines(corpus).map(parseStepBlock).filter((id): id is string => id !== null),
  );
  // The title is not decoration: the evidence table, the review of the
  // generated test and the run's per-step screenshots all read it back to say
  // which assertions belong to which step. A rewrite that reshapes it leaves
  // every step reporting as deciding nothing, and the real finding is then
  // buried in the false ones. A judge step is titled the same way, so it is
  // checked here too — its claim is asserted, and a table saying otherwise
  // understates coverage.
  for (const stepId of [...markers.map((m) => m.stepId), ...judgements.map((j) => j.step.id)]) {
    if (titled.has(stepId)) continue;
    warnings.push(
      `step ${stepId}: the generated test no longer opens that step with the \`test.step\` title the ` +
        `draft wrote. The evidence table, the run's screenshots and the spec review read it back to ` +
        `attribute assertions, so a reshaped one makes all three report the step as deciding ` +
        `nothing. Keep the title unchanged.`,
    );
  }
  // Neither of these breaks a run, which is why nothing else would notice: a
  // test that lost its tag drops out of whatever selection runs it, and one
  // that lost its header no longer says where the case came from.
  const firstHeaderLine = stamped.header.split("\n")[0]?.trim() ?? "";
  if (firstHeaderLine && !corpus.includes(firstHeaderLine)) {
    warnings.push(
      `the generated test no longer opens with the configured header — a rewrite pass dropped it, ` +
        `so the file does not say which case it came from`,
    );
  }
  if (stamped.titleSuffix && !corpus.includes(stamped.titleSuffix.trim())) {
    warnings.push(
      `the generated test's name no longer ends with "${stamped.titleSuffix.trim()}" — a rewrite ` +
        `pass dropped the tag, and whatever selects tests by it will skip this one`,
    );
  }
  // A dropped claim is worse than a dropped screenshot: the spec keeps
  // running and stays green while asserting nothing.
  for (const { step } of judgements) {
    if (judgeCall(step).pattern.test(corpus)) continue;
    warnings.push(
      `step ${step.id}: generated test is missing its ${JUDGE_CALL} call — that claim is never ` +
        `decided and the spec passes without testing it. A rewrite pass must not drop or reword it.`,
    );
  }
  return warnings;
}

/**
 * Anything of ccqa's the written test loads.
 *
 * A committed spec is the project's, and their CI type-checks it in a checkout
 * where ccqa is not installed — so an import of it is not a style question but
 * a broken build. The one exception is the judge: a claim is decided at run
 * time by a model, so a case that states one genuinely depends on it.
 *
 * Mechanical because nothing else catches it. The rewrite pass reads the
 * repository, and where an earlier ccqa already wrote a spec at this path it
 * imitates that spec's shape — which type-checks, runs, and passes every other
 * gate here.
 */
function runtimeImportGaps(corpus: string): string[] {
  const loaded = new Set<string>();
  for (const specifier of importedSpecifiers(corpus)) {
    if (specifier !== "ccqa" && !specifier.startsWith("ccqa/")) continue;
    if (specifier === JUDGE_MODULE) continue;
    loaded.add(specifier);
  }
  if (loaded.size === 0) return [];
  return [
    `the generated test imports ${[...loaded].sort().join(", ")} — a spec ccqa writes is plain ` +
      `@playwright/test and must not load ccqa at run time, because the project type-checks and ` +
      `runs it where ccqa is not installed. Remove the import and every call into it, and write ` +
      `each of the case's steps as \`await test.step("<the draft's title>", async () => { ... })\` ` +
      `around that step's own actions. \`${JUDGE_MODULE}\` is the only ccqa import a spec may ` +
      `carry, and only a case with a \`judgeByLlm\` claim carries it.`,
  ];
}

/**
 * Each claim paired with the action index it is asserted after: the last
 * action of the nearest preceding step. A claim reads what the run has
 * produced so far, so emitting it at the end of the test would judge a page
 * later steps have already navigated away from.
 *
 * A claim whose preceding steps recorded nothing has no position the
 * recording can justify. It goes last and says so, because the alternative —
 * the previous claim's index, or the start — judges a page the spec never
 * meant, and a negative claim would pass there without being tested.
 */
export function placeJudgements(
  expanded: ExpandedStep[],
  actions: RecordedAction[],
  specKey: string,
): { judgements: Judgement[]; warnings: string[] } {
  const lastIndex = lastActionIndexPerStep(actions);
  const judgements: Judgement[] = [];
  const warnings: string[] = [];
  let afterActionIndex: number | null = null;
  for (const step of expanded) {
    if (!isExpandedJudgeByLlmStep(step)) {
      afterActionIndex = lastIndex.get(step.id) ?? afterActionIndex;
      continue;
    }
    if (afterActionIndex === null) {
      if (expanded.indexOf(step) === 0) {
        throw new Error(
          `${specKey}: step ${step.id} uses \`judgeByLlm\` as the first step — there is nothing on the page to judge yet.`,
        );
      }
      warnings.push(
        `step ${step.id}: no recorded action belongs to the steps before this claim, so it is asserted ` +
          `at the end of the test instead of where the spec puts it. Re-record if the claim reads ` +
          `something a later step navigates away from.`,
      );
      judgements.push({ step, afterActionIndex: actions.length - 1 });
      continue;
    }
    judgements.push({ step, afterActionIndex });
  }
  return { judgements, warnings };
}
