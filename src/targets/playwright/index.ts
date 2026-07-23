import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAllBlocks } from "../../store/index.ts";
import { expandSpec } from "../../spec/expand.ts";
import type { StepMarker } from "../../codegen/actions-to-script.ts";
import { playwrightTaskInstructions } from "../../prompts/llm-gen.ts";
import { buildStepMarkers } from "../agent-browser/generate.ts";
import {
  existingOutputFromManifest,
  finalizePreparedFiles,
  generateWithLlmEngine,
  specDirRel,
} from "../llm-engine.ts";
import {
  emitPlaywrightDraft,
  STEP_EVIDENCE_AFTER,
  STEP_EVIDENCE_BEFORE,
  stepEvidenceCall,
  stepEvidencePreserveRule,
} from "./emit-mechanical.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { GenerateContext, GenerateResult, SpecRef, TargetPlugin } from "../types.ts";
import * as log from "../../cli/logger.ts";

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
 * write + `generated.json` manifest + runCommand verification loop.
 */
export const playwrightTarget: TargetPlugin = {
  id: PLAYWRIGHT_TARGET,
  input: "recording",
  generate: generatePlaywrightTest,
  existingOutput: existingPlaywrightOutput,
  runner: runCommandRunner,
  // The emitter injects `ccqa/step-evidence` calls at every step boundary, so
  // a run produces the same per-step before/after screenshots agent-browser
  // does — `ccqa run` sets CCQA_EVIDENCE_DIR for these specs.
  stepEvidence: { supported: true },
  guidanceKind: PLAYWRIGHT_TARGET,
};

async function generatePlaywrightTest(ctx: GenerateContext): Promise<GenerateResult> {
  const actions = ctx.recording;
  if (!actions) {
    throw new Error(
      `the playwright target needs a recording — run \`ccqa record ${ctx.featureName}/${ctx.specName}\` first`,
    );
  }
  const blocks = await loadAllBlocks(ctx.cwd);
  const expanded = expandSpec(ctx.spec, { blocks });
  const stepMarkers = buildStepMarkers(expanded, actions);
  const draft = emitPlaywrightDraft({
    actions,
    testName: ctx.spec.title,
    stepMarkers,
  });
  // Suggested location; the LLM pass may relocate within the write roots
  // when the repo's conventions clearly use another layout. Without a
  // configured outDir the spec directory itself is the output — the same
  // `test.spec.ts` convention as the agent-browser target, so every spec
  // carries its own runnable test next to spec.yaml / ir.json.
  const outDir = ctx.targetConfig.outDir;
  const draftPath = outDir
    ? `${outDir}/${ctx.featureName}/${ctx.specName}.spec.ts`
    : `${specDirRel(ctx)}/test.spec.ts`;
  if (!outDir) {
    // Without an outDir the Playwright test lands at the spec dir's
    // `test.spec.ts` — the exact path the agent-browser deterministic runner
    // treats as its vitest recording. Running the spec later could then pick
    // the wrong runner. Recommend an outDir, but don't hard-fail: existing
    // single-target playwright projects rely on this default.
    log.warn(
      `no \`outDir\` configured for the playwright target — writing ${draftPath}, the same path the ` +
        `agent-browser target uses for its vitest test. Set \`targets.playwright.outDir\` in ` +
        `.ccqa/config.yaml (e.g. \`e2e/specs\`) to keep them apart.`,
    );
  }

  log.meta("actions", actions.length);
  log.meta("mode", ctx.resources.length > 0 ? "mechanical emit + library rewrite" : "mechanical emit");
  log.blank();

  const result =
    ctx.resources.length > 0
      ? await generateWithLlmEngine({
          ctx,
          target: PLAYWRIGHT_TARGET,
          taskInstructions: playwrightTaskInstructions(draftPath),
          draft: { path: draftPath, contents: draft },
          // Only injected when the draft actually has markers to preserve.
          ...(stepMarkers.length > 0 ? { draftInvariant: stepEvidencePreserveRule() } : {}),
        })
      : await finalizePreparedFiles({
          ctx,
          target: PLAYWRIGHT_TARGET,
          files: [{ path: draftPath, contents: draft, kind: "test" }],
          summary: `Playwright spec compiled from ${actions.length} recorded action(s)`,
          warnings: [],
        });

  // Gate: every step must keep both capture calls in the written test. The
  // deterministic emit always has them; the library-rewrite pass can drop them
  // when it restructures into page objects, which silently costs the spec its
  // report screenshots — so verify the files on disk and warn, per step.
  const missing = await missingStepEvidence(result, stepMarkers);
  for (const w of missing) log.warn(w);
  return { ...result, warnings: [...result.warnings, ...missing] };
}

/**
 * Per-step warning for any `ccqa/step-evidence` boundary call absent from the
 * generated test files — the report would then miss that step's screenshots.
 * Reads the written test files (the LLM pass may have relocated them); a file
 * that can't be read is reported as missing all its steps rather than passing
 * silently.
 */
async function missingStepEvidence(
  result: GenerateResult,
  markers: StepMarker[],
): Promise<string[]> {
  if (markers.length === 0) return [];
  const sources = await Promise.all(
    result.files
      .filter((f) => f.kind === "test")
      .map((f) => readFile(f.path, "utf8").catch(() => "")),
  );
  const corpus = sources.join("\n");
  const warnings: string[] = [];
  for (const m of markers) {
    const hasBefore = corpus.includes(stepEvidenceCall(STEP_EVIDENCE_BEFORE, m));
    const hasAfter = corpus.includes(stepEvidenceCall(STEP_EVIDENCE_AFTER, m));
    if (!hasBefore || !hasAfter) {
      warnings.push(
        `step ${m.stepId}: generated test is missing its ${STEP_EVIDENCE_BEFORE}/${STEP_EVIDENCE_AFTER} ` +
          `call(s) — that step will have no report screenshots. A rewrite pass must not drop them.`,
      );
    }
  }
  return warnings;
}

/**
 * Overwrite-guard hook: the manifest's files first, then the default
 * spec-dir `test.spec.ts` — that path may be owned by another target (an
 * agent-browser recording), and regenerating through playwright without a
 * configured outDir would clobber it. With an outDir configured this can
 * flag a file the write won't touch; the guard is a y/N prompt (or
 * `--force`), so erring toward asking is the safe side.
 */
async function existingPlaywrightOutput(ref: SpecRef, cwd: string): Promise<string | null> {
  const fromManifest = await existingOutputFromManifest(ref, cwd);
  if (fromManifest) return fromManifest;
  const specTest = resolve(cwd, `${specDirRel(ref)}/test.spec.ts`);
  return stat(specTest).then(
    () => specTest,
    () => null,
  );
}
