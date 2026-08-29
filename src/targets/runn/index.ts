import { parse as parseYaml } from "yaml";
import { runnTaskInstructions } from "../../prompts/llm-gen.ts";
import { expandActionSteps } from "../../spec/expand.ts";
import { loadAllBlocks } from "../../store/index.ts";
import {
  existingOutputFromManifest,
  generateWithLlmEngine,
  specDirRel,
  type InvokeFn,
  type LlmGeneratedFile,
} from "../llm-engine.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { CapabilitySupport, GenerateContext, GenerateResult, TargetPlugin } from "../types.ts";

const RUNN_TARGET = "runn";
const JUDGE_STEPS = {
  supported: false,
  reason: "runn runs API scenarios; there is no page to read a claim off",
} as const satisfies CapabilitySupport;

/**
 * The runn target (input: "spec"): no record phase — `ccqa generate` compiles
 * the spec directly into a runn runbook (YAML) via the shared LLM engine. The
 * prompt prescribes only runn's generic runbook shape; concrete endpoints and
 * payloads must be verified against the backend sources, found via
 * Read/Grep/Glob.
 */
export const runnTarget: TargetPlugin = {
  id: RUNN_TARGET,
  input: "spec",
  generate: (ctx) => generateRunnRunbook(ctx),
  existingOutput: existingOutputFromManifest,
  runner: runCommandRunner,
  // runn drives an API scenario — there is no browser to screenshot, so the
  // report records this reason instead of showing an empty evidence section.
  stepEvidence: { supported: false, reason: "runn runs API scenarios, which have no screen to capture" },
  // Same fact, different consequence: with no browser there is nothing to
  // attach coverage acquisition to, and no cookie carrier for the server half.
  browserCoverage: { browser: "none", reason: "runn runs API scenarios; there is no browser to measure" },
  judgeSteps: JUDGE_STEPS,
  guidanceKind: RUNN_TARGET,
};

/** Exported with the engine's invoke seam so unit tests can stub Claude. */
export async function generateRunnRunbook(
  ctx: GenerateContext,
  invoke?: InvokeFn,
): Promise<GenerateResult> {
  // Without a configured outDir the runbook lands in the spec directory,
  // next to spec.yaml — the same layout as the other targets.
  const outDir = ctx.targetConfig.outDir;
  const blocks = await loadAllBlocks(ctx.cwd);
  const steps = expandActionSteps(ctx.spec, { blocks }, `${ctx.featureName}/${ctx.specName}`, {
    id: RUNN_TARGET,
    reason: JUDGE_STEPS.reason,
  });
  return generateWithLlmEngine({
    ctx,
    target: RUNN_TARGET,
    steps,
    taskInstructions: runnTaskInstructions(
      outDir ? `${outDir}/${ctx.featureName}/${ctx.specName}.yaml` : `${specDirRel(ctx)}/runbook.yaml`,
    ),
    validateFile: validateRunnFile,
    invoke,
  });
}

/**
 * Every generated file — runbooks and helper runbooks alike — must be YAML
 * that actually parses; a broken runbook is rejected before it reaches disk.
 */
export function validateRunnFile(file: LlmGeneratedFile): string | null {
  if (!/\.ya?ml$/.test(file.path)) {
    return `${file.path}: runn output must be a YAML runbook (.yaml / .yml)`;
  }
  try {
    parseYaml(file.contents);
  } catch (e) {
    return `${file.path} is not valid YAML: ${(e as Error).message}`;
  }
  return null;
}
