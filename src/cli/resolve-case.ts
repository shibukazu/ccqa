import { caseRefFor, type SpecRef } from "../store/index.ts";
import type { TestCase } from "../cases/case.ts";
import { caseTargetFor, openCaseReader } from "../cases/reader.ts";
import { registryFor, resolveTarget, resolveTargetOverride } from "../targets/registry.ts";
import {
  resolveCaseRecordingPath,
  resolveCaseTestPath,
  resolveRecordingPath,
  resolveTestPath,
} from "../targets/test-path.ts";
import { targetConfigFor, type ProjectConfig, type TargetConfig } from "../config/project-config.ts";
import type { TestSpec } from "../spec/yaml-schema.ts";
import type { TargetPlugin } from "../targets/types.ts";

/**
 * What a command's `<case>` argument names.
 *
 * Two kinds of document state a test case, and which one a project writes is
 * settled by its target, not by guessing at the argument's shape: a target
 * that declares a case source reads its cases from the project's own files,
 * and one that does not reads ccqa's `spec.yaml`. So the target is resolved
 * first — from `--target`, else the project's `defaultTarget` — and the
 * argument is then read the way that target's cases are written.
 *
 * The consequence worth knowing: in a project whose `defaultTarget` reads its
 * own documents, reaching a `spec.yaml` case means naming the target that owns
 * it (`--target playwright`). That is one flag in the uncommon direction,
 * against a rule with no ambiguity in it.
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
  const reader = openCaseReader(config, cwd, opts);
  const testCase = await reader.load(argument);

  if (reader.target) {
    const { id, targetConfig, modulePath } = reader.target;
    const target = registryFor(config).get(id)!;
    const testPath = resolveCaseTestPath(target, targetConfig, testCase.ref.id);
    // As in the spec branch below: `--target` redirects what this invocation
    // writes, and the recording stays where the case's own target puts it.
    const recordingPath =
      (opts.targetOverride === undefined
        ? undefined
        : ownCaseRecordingPath(config, cwd, modulePath, testCase.ref.id)) ??
      resolveCaseRecordingPath(target, targetConfig, testCase.ref.id);
    const ref = caseRefFor(testCase.ref.id, cwd, recordingPath);
    return { testCase: { ...testCase, ref }, target, targetConfig, testPath };
  }

  const spec = testCase.spec!;
  const specRef = splitSpecRef(testCase.ref.id);
  const target =
    opts.targetOverride !== undefined
      ? resolveTargetOverride(spec, opts.targetOverride, config)
      : resolveTarget(spec, config);
  const targetConfig = targetConfigFor(config, target.id);
  const testPath = resolveTestPath(target, targetConfig, specRef);
  // The recording belongs to the case, so it stays where the spec's own target
  // puts the test: `--target` redirects what this invocation writes, not where
  // the route was recorded.
  const ref = caseRefFor(
    specRef,
    cwd,
    opts.targetOverride === undefined
      ? resolveRecordingPath(target, targetConfig, specRef)
      : ownRecordingPath(spec, config, specRef),
  );
  return { testCase: { ...testCase, ref }, target, targetConfig, testPath };
}

/** A spec case's id is its two coordinates joined, and only ever those two. */
function splitSpecRef(id: string): SpecRef {
  const [featureName, specName] = id.split("/");
  return { featureName: featureName!, specName: specName! };
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
 * The case-source branch's half of the same rule: where the project's own
 * default target keeps this case's recording.
 *
 * Undefined when that target reads its cases through a different module than
 * the one this invocation resolved through — another module is describing a
 * different case that happens to share an id, and its route is not this
 * case's.
 */
function ownCaseRecordingPath(
  config: ProjectConfig,
  cwd: string,
  readingModule: string,
  caseId: string,
): string | undefined {
  const own = caseTargetFor(config, cwd);
  if (own === null || own.modulePath !== readingModule) return undefined;
  const plugin = registryFor(config).get(own.id);
  return plugin ? resolveCaseRecordingPath(plugin, own.targetConfig, caseId) : undefined;
}
