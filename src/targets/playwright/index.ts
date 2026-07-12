import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadAllBlocks } from "../../store/index.ts";
import { expandSpec } from "../../spec/expand.ts";
import { playwrightTaskInstructions } from "../../prompts/llm-gen.ts";
import { buildStepMarkers } from "../agent-browser/generate.ts";
import {
  existingOutputFromManifest,
  finalizePreparedFiles,
  generateWithLlmEngine,
  specDirRel,
} from "../llm-engine.ts";
import { emitPlaywrightDraft } from "./emit-mechanical.ts";
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
  const draft = emitPlaywrightDraft({
    actions,
    testName: ctx.spec.title,
    stepMarkers: buildStepMarkers(expanded, actions),
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

  log.meta("actions", actions.length);
  log.meta("mode", ctx.resources.length > 0 ? "mechanical emit + library rewrite" : "mechanical emit");
  log.blank();

  if (ctx.resources.length > 0) {
    return generateWithLlmEngine({
      ctx,
      target: PLAYWRIGHT_TARGET,
      taskInstructions: playwrightTaskInstructions(draftPath),
      draft: { path: draftPath, contents: draft },
    });
  }
  return finalizePreparedFiles({
    ctx,
    target: PLAYWRIGHT_TARGET,
    files: [{ path: draftPath, contents: draft, kind: "test" }],
    summary: `Playwright spec compiled from ${actions.length} recorded action(s)`,
    warnings: [],
  });
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
