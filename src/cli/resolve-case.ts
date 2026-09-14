import { caseRefFor, loadAllBlocks, parseSpecPath, readSpecFile, type SpecRef } from "../store/index.ts";
import { caseFromSpec, loadMarkdownCase, type TestCase } from "../intent/case.ts";
import { registryFor, resolveTarget, resolveTargetOverride } from "../targets/registry.ts";
import {
  resolveCaseRecordingPath,
  resolveCaseTestPath,
  resolveRecordingPath,
  resolveTestPath,
} from "../targets/test-path.ts";
import {
  targetConfigFor,
  type IntentSource,
  type ProjectConfig,
  type TargetConfig,
} from "../config/project-config.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
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
    const { id, targetConfig, intent } = intentTarget;
    const target = registryFor(config).get(id)!;
    const testCase = await loadMarkdownCase(argument, intent, cwd);
    const testPath = resolveCaseTestPath(target, targetConfig, testCase.ref.id);
    // As in the spec branch below: `--target` redirects what this invocation
    // writes, and the recording stays where the case's own target puts it.
    const recordingPath =
      (opts.targetOverride === undefined
        ? undefined
        : ownIntentRecordingPath(config, intent, testCase.ref.id)) ??
      resolveCaseRecordingPath(target, targetConfig, testCase.ref.id);
    const ref = caseRefFor(testCase.ref.id, cwd, recordingPath);
    return { testCase: { ...testCase, ref }, target, targetConfig, testPath };
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
  const specRef = { featureName, specName };
  const testPath = resolveTestPath(target, targetConfig, specRef);
  // The recording belongs to the case, so it stays where the spec's own target
  // puts the test: `--target` redirects what this invocation writes, not where
  // the route was recorded.
  const ref = caseRefFor(
    specRef,
    cwd,
    opts.targetOverride === undefined
      ? resolveRecordingPath(target, targetConfig, specRef)
      : ownRecordingPath(spec!, config, specRef),
  );
  return { testCase: { ...testCase, ref }, target, targetConfig, testPath };
}

/**
 * Where the spec's own target keeps this case's recording, ignoring any
 * `--target`. Undefined when that target no longer resolves: overriding the
 * target is how a spec with an unusable one is generated at all, so it must
 * not be what stops the command.
 *
 * Only the resolution is guarded. A target that resolved and then could not
 * expand its own `testPath` is a broken config, and swallowing that would put
 * the recording somewhere else without a word.
 */
function ownRecordingPath(
  spec: TestSpec,
  config: ProjectConfig,
  ref: SpecRef,
): string | undefined {
  let target: TargetPlugin;
  try {
    target = resolveTarget(spec, config);
  } catch {
    return undefined;
  }
  return resolveRecordingPath(target, targetConfigFor(config, target.id), ref);
}

/**
 * The intent branch's half of the same rule: where the project's own default
 * target keeps this case's recording.
 *
 * Undefined when that target reads a different set of cases than the one this
 * invocation resolved through — a target pointed at another directory is
 * describing a different case that happens to share an id, and its route is
 * not this case's.
 */
function ownIntentRecordingPath(
  config: ProjectConfig,
  reading: IntentSource,
  caseId: string,
): string | undefined {
  const own = intentTargetFor(config);
  if (own === null || own.intent.root !== reading.root) return undefined;
  const plugin = registryFor(config).get(own.id);
  return plugin ? resolveCaseRecordingPath(plugin, own.targetConfig, caseId) : undefined;
}

/** A target that reads its cases from the project's own documents. */
export interface IntentTarget {
  id: string;
  targetConfig: TargetConfig;
  intent: IntentSource;
}

/** The target whose cases live in the project, when that is what we resolve to. */
export function intentTargetFor(
  config: ProjectConfig,
  targetOverride?: string,
): IntentTarget | null {
  const id = targetOverride ?? config.defaultTarget;
  const targetConfig = config.targets[id];
  return targetConfig?.intent ? { id, targetConfig, intent: targetConfig.intent } : null;
}
