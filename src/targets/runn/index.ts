import { parse as parseYaml } from "yaml";
import { runnTaskInstructions } from "../../prompts/llm-gen.ts";
import {
  existingOutputFromManifest,
  generateWithLlmEngine,
  requireOutDir,
  type InvokeFn,
  type LlmGeneratedFile,
} from "../llm-engine.ts";
import { runCommandRunner } from "../run-command-runner.ts";
import type { GenerateContext, GenerateResult, TargetPlugin } from "../types.ts";

const RUNN_TARGET = "runn";

/**
 * The runn target (input: "spec"): no record phase — `ccqa generate` compiles
 * the spec directly into a runn runbook (YAML) via the shared LLM engine. The
 * prompt prescribes only runn's generic runbook shape; concrete endpoints and
 * payloads must be verified against the backend sources the spec's
 * `relatedPaths` point at.
 */
export const runnTarget: TargetPlugin = {
  id: RUNN_TARGET,
  input: "spec",
  generate: (ctx) => generateRunnRunbook(ctx),
  existingOutput: existingOutputFromManifest,
  runner: runCommandRunner,
};

/** Exported with the engine's invoke seam so unit tests can stub Claude. */
export async function generateRunnRunbook(
  ctx: GenerateContext,
  invoke?: InvokeFn,
): Promise<GenerateResult> {
  const outDir = requireOutDir(ctx, RUNN_TARGET);
  return generateWithLlmEngine({
    ctx,
    target: RUNN_TARGET,
    taskInstructions: runnTaskInstructions(`${outDir}/${ctx.featureName}/${ctx.specName}.yaml`),
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
