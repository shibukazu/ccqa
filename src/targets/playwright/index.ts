import { readFile } from "node:fs/promises";
import { saveSpecReview, SPEC_DIR_TEMPLATE, TEST_SCRIPT_FILE } from "../../store/index.ts";
import { renderHeader, renderTitleTag } from "../external/header.ts";
import {
  expandSpec,
  isExpandedActionStep,
  isExpandedJudgeByLlmStep,
  type ExpandedStep,
} from "../../spec/expand.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";
import type { RecordedAction } from "../../types.ts";
import { playwrightTaskInstructions } from "../../prompts/llm-gen.ts";
import { buildStepMarkers, lastActionIndexPerStep } from "../agent-browser/generate.ts";
import { finalizePreparedFiles, generateWithLlmEngine } from "../llm-engine.ts";
import {
  emitPlaywrightDraft,
  headerPreserveRule,
  judgeCall,
  JUDGE_CALL,
  type Judgement,
  STEP_EVIDENCE_AFTER,
  STEP_EVIDENCE_BEFORE,
  stepEvidenceCall,
  judgePreserveRule,
  stepEvidencePreserveRule,
} from "./emit-mechanical.ts";
import { acquirePlaywrightBrowser } from "./browser-server.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { GenerateContext, GenerateResult, TargetPlugin } from "../types.ts";
import * as log from "../../cli/logger.ts";
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
  // The emitter injects `ccqa/step-evidence` calls at every step boundary, so
  // a run produces the same per-step before/after screenshots agent-browser
  // does — `ccqa run` sets CCQA_EVIDENCE_DIR for these specs.
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
  return compileRecording(ctx, PLAYWRIGHT_TARGET);
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
 */
export async function compileRecording(
  ctx: GenerateContext,
  guidanceKind: "playwright",
): Promise<GenerateResult> {
  const actions = ctx.recording!;
  // Steps arrive expanded: whichever document stated the case, resolving it
  // did that work, and doing it again here would be a second reading of the
  // same file with a chance of disagreeing.
  const expanded = ctx.steps;
  const cleanup = ctx.cleanup.filter(isExpandedActionStep);
  const captures = ctx.targetConfig.hooks.stepEvidence;
  // A judge step records no actions, so it has no marker to place. Its call is
  // emitted into the draft instead, which is what keeps a claim from depending
  // on a rewrite choosing to keep it.
  const stepMarkers = buildStepMarkers(expanded.filter(isExpandedActionStep), actions);
  const cleanupMarkers = buildStepMarkers(cleanup, ctx.cleanupRecording ?? []);
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
    stepEvidence: captures,
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
    stepMarkers.length > 0 && captures ? stepEvidencePreserveRule() : "",
    judgements.length > 0 ? judgePreserveRule() : "",
    header || titleSuffix ? headerPreserveRule(header, titleSuffix) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result =
    ctx.resources.length > 0
      ? await generateWithLlmEngine({
          ctx,
          target: guidanceKind,
          steps: expanded,
          taskInstructions: playwrightTaskInstructions(ctx.testPath),
          draft: { path: ctx.testPath, contents: draft },
          ...(invariants ? { draftInvariant: invariants } : {}),
        })
      : await finalizePreparedFiles({
          ctx,
          target: guidanceKind,
          files: [{ path: ctx.testPath, contents: draft, kind: "test" }],
          summary: `test compiled from ${actions.length} recorded action(s)`,
          warnings: [],
        });

  const missing = await missingInjectedCalls(result, captures ? stepMarkers : [], judgements, {
    header,
    titleSuffix,
  });
  for (const w of missing) log.warn(w);
  // The loop above only ever asked "does it go green". A rewrite that weakens
  // an assertion clears that bar too, so green is not evidence that the case
  // was checked. This is the only pass that looks.
  const review = await reviewGeneratedTest({
    result,
    steps: expanded,
    language: ctx.language,
    ...(ctx.model ? { model: ctx.model } : {}),
    cwd: ctx.cwd,
  });
  for (const w of review.warnings) log.warn(w);
  await saveSpecReview(ctx.ref, review);
  return {
    ...result,
    warnings: [...result.warnings, ...judgeWarnings, ...missing, ...review.warnings],
  };
}

/**
 * Warnings for calls the emitter injected that the written test no longer has.
 * The deterministic emit always has them; the library-rewrite pass can drop
 * them when it restructures into page objects, which silently costs the spec
 * its screenshots. Reads the files from disk (the LLM pass may have relocated
 * them); a file that can't be read is reported as missing everything rather
 * than passing silently.
 */
async function missingInjectedCalls(
  result: GenerateResult,
  markers: StepMarker[],
  judgements: Judgement[],
  stamped: { header: string; titleSuffix: string } = { header: "", titleSuffix: "" },
): Promise<string[]> {
  const sources = await Promise.all(
    result.files
      .filter((f) => f.kind === "test")
      .map((f) => readFile(f.path, "utf8").catch(() => "")),
  );
  const corpus = sources.join("\n");
  const warnings: string[] = [];
  for (const m of markers) {
    const hasBefore = stepEvidenceCall(STEP_EVIDENCE_BEFORE, m).pattern.test(corpus);
    const hasAfter = stepEvidenceCall(STEP_EVIDENCE_AFTER, m).pattern.test(corpus);
    if (!hasBefore || !hasAfter) {
      warnings.push(
        `step ${m.stepId}: generated test is missing its ${STEP_EVIDENCE_BEFORE}/${STEP_EVIDENCE_AFTER} ` +
          `call(s) — that step will have no report screenshots. A rewrite pass must not drop them.`,
      );
    }
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
