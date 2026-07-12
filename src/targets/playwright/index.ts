import { loadAllBlocks } from "../../store/index.ts";
import { expandSpec } from "../../spec/expand.ts";
import { playwrightTaskInstructions } from "../../prompts/llm-gen.ts";
import { buildStepMarkers } from "../agent-browser/generate.ts";
import {
  existingOutputFromManifest,
  finalizePreparedFiles,
  generateWithLlmEngine,
  requireOutDir,
} from "../llm-engine.ts";
import { emitPlaywrightDraft } from "./emit-mechanical.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { GenerateContext, GenerateResult, TargetPlugin } from "../types.ts";
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
  existingOutput: existingOutputFromManifest,
  runner: runCommandRunner,
};

async function generatePlaywrightTest(ctx: GenerateContext): Promise<GenerateResult> {
  const actions = ctx.recording;
  if (!actions) {
    throw new Error(
      `the playwright target needs a recording — run \`ccqa record ${ctx.featureName}/${ctx.specName}\` first`,
    );
  }
  const outDir = requireOutDir(ctx, PLAYWRIGHT_TARGET);

  const blocks = await loadAllBlocks(ctx.cwd);
  const expanded = expandSpec(ctx.spec, { blocks });
  const draft = emitPlaywrightDraft({
    actions,
    testName: ctx.spec.title,
    stepMarkers: buildStepMarkers(expanded, actions),
  });
  // Suggested location; the LLM pass may relocate within outDir when the
  // repo's conventions clearly use another layout.
  const draftPath = `${outDir}/${ctx.featureName}/${ctx.specName}.spec.ts`;

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
