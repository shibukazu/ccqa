import { loadAllBlocks, parseSpecPath, readSpecFile } from "../store/index.ts";
import { caseFromSpec, loadMarkdownCase, type TestCase } from "../intent/case.ts";
import { registryFor, resolveTarget, resolveTargetOverride } from "../targets/registry.ts";
import { resolveCaseTestPath, resolveTestPath } from "../targets/test-path.ts";
import { targetConfigFor, type ProjectConfig, type TargetConfig } from "../config/project-config.ts";
import type { TargetPlugin } from "../targets/types.ts";

/**
 * What a command's `<case>` argument names.
 *
 * Two kinds of document state a test case, and which one a project writes is
 * settled by its target, not by guessing at the argument's shape: a target
 * that declares an `intent` source reads its cases from the project's own
 * files, and one that does not reads ccqa's `spec.yaml`. So the target is
 * resolved first — from `--target`, else the project's `defaultTarget` — and
 * the argument is then read the way that target's cases are written.
 *
 * The consequence worth knowing: in a project whose `defaultTarget` reads
 * markdown, reaching a `spec.yaml` case means naming the target that owns it
 * (`--target playwright`). That is one flag in the uncommon direction, against
 * a rule with no ambiguity in it.
 */
export interface ResolvedCase {
  testCase: TestCase;
  target: TargetPlugin;
  targetConfig: TargetConfig;
  /** Where this case's generated test goes, relative to the project root. */
  testPath: string;
}

export interface ResolveCaseOptions {
  /** CLI `--target`: generate through this target instead of the case's own. */
  targetOverride?: string;
}

export async function resolveCase(
  argument: string,
  config: ProjectConfig,
  cwd: string,
  opts: ResolveCaseOptions = {},
): Promise<ResolvedCase> {
  const intentTarget = intentTargetFor(config, opts.targetOverride);
  if (intentTarget) {
    const { id, targetConfig } = intentTarget;
    const target = registryFor(config).get(id)!;
    const testCase = await loadMarkdownCase(argument, targetConfig.intent!, cwd);
    return {
      testCase,
      target,
      targetConfig,
      testPath: resolveCaseTestPath(target, targetConfig, testCase.ref.id),
    };
  }

  const { featureName, specName } = parseSpecPath(argument);
  const yaml = await readSpecFile(featureName, specName, cwd);
  const blocks = await loadAllBlocks(cwd);
  const testCase = caseFromSpec(featureName, specName, yaml, blocks, cwd);
  const spec = testCase.source.kind === "spec" ? testCase.source.spec : null;
  const target =
    opts.targetOverride !== undefined
      ? resolveTargetOverride(spec!, opts.targetOverride, config)
      : resolveTarget(spec!, config);
  const targetConfig = targetConfigFor(config, target.id);
  return {
    testCase,
    target,
    targetConfig,
    testPath: resolveTestPath(target, targetConfig, { featureName, specName }),
  };
}

/** The target whose cases live in the project, when that is what we resolve to. */
function intentTargetFor(
  config: ProjectConfig,
  targetOverride: string | undefined,
): { id: string; targetConfig: TargetConfig } | null {
  const id = targetOverride ?? config.defaultTarget;
  const targetConfig = config.targets[id];
  return targetConfig?.intent ? { id, targetConfig } : null;
}
