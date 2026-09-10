import { relative } from "node:path";
import * as log from "../cli/logger.ts";
import { runsLive } from "../cli/live-case.ts";
import { intentTargetFor, type IntentTarget } from "../cli/resolve-case.ts";
import { loadProjectConfig, targetConfigFor, type ProjectConfig } from "../config/project-config.ts";
import { listMarkdownCases, loadMarkdownCase, type TestCase } from "../intent/case.ts";
import {
  collectIncludedBlockNames,
  expandSpec,
  isJudgeBody,
  type AnyStepBody,
} from "../spec/expand.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  isIncludeStep,
  type BlockSpec,
  type Step,
  type TestSpec,
} from "../spec/yaml-schema.ts";
import { registryFor, resolveTarget } from "../targets/registry.ts";
import { resolveCaseTestPath, resolveTestPath } from "../targets/test-path.ts";
import { listAllSpecsWithSpecFile, loadAllBlocks, splitCaseId, tryReadSpecFile } from "../store/index.ts";

/**
 * What the model is told about one spec: enough to judge whether a change
 * reaches it, and no more.
 *
 * The steps carry the weight here. A title says which feature a spec belongs
 * to; only the steps say which screens it opens, which controls it drives,
 * and which strings it asserts on — which is exactly what a source change
 * either does or does not disturb.
 */
export interface SpecDescription {
  featureName: string;
  specName: string;
  title: string;
  /**
   * One line per step, in order. Include steps are inlined as the block's own
   * steps, so the model sees what a shared block (login, navigation, ...)
   * actually does rather than just its name.
   */
  steps: string[];
  /** Blocks this spec includes, so a change to one can be matched mechanically. */
  includedBlocks: string[];
  /**
   * Project-root-relative path of this spec's generated test file, resolved
   * the same way `ccqa run` finds it (target + testPath template). Empty
   * when the spec's target itself can't be resolved — `--format paths`
   * drops those rather than emitting a path that names nothing.
   */
  testPath: string;
  /**
   * Project-root-relative path of the document that states this case: a
   * spec's `spec.yaml`, or a markdown case's own file. `partitionChanges`
   * matches a changed file against this to select a case whose own document
   * changed — the one identity that works for both document kinds, since a
   * markdown case's file isn't under `.ccqa/` for the directory-prefix match
   * spec cases get.
   */
  sourcePath: string;
}

/**
 * Read every test case the project states into the shape the selection
 * prompt consumes: ccqa's own specs under `.ccqa/features/`, or — for a
 * project whose target reads an intent source — its own markdown cases.
 * Which one a project has is a property of its target, never both at once
 * (see `intentTargetFor`), so this reads one enumeration or the other.
 */
export async function loadSpecInventory(cwd: string): Promise<SpecDescription[]> {
  const config = await loadProjectConfig(cwd);
  const intentTarget = intentTargetFor(config);
  if (intentTarget) return loadMarkdownInventory(intentTarget, config, cwd);
  return loadSpecFileInventory(config, cwd);
}

/**
 * Specs without a spec file are skipped: there is nothing to judge and
 * nothing to run.
 *
 * Enumeration (`listAllSpecsWithSpecFile`, a directory walk) is kept separate
 * from reading and parsing each spec's own content, so every spec.yaml is
 * read and parsed exactly once — and the reads run in parallel.
 */
async function loadSpecFileInventory(config: ProjectConfig, cwd: string): Promise<SpecDescription[]> {
  // Blocks are shared across specs, so loaded once here rather than per spec.
  const [refs, blocks] = await Promise.all([listAllSpecsWithSpecFile(cwd), loadAllBlocks(cwd)]);
  const specs = await Promise.all(
    refs.map(async ({ featureName, specName }): Promise<SpecDescription | null> => {
      const content = await tryReadSpecFile(featureName, specName, cwd);
      if (content === null) return null;

      // Deliberately not caught. The steps are what the decision is made
      // against, so a spec that will not parse cannot be judged — and the
      // model, given only a name, answers `notNeeded` as confidently as if it
      // had read one. Degrading here would clear specs on no evidence, which
      // is the one outcome this command must never produce.
      const spec = parseTestSpec(content, `${featureName}/${specName}/spec.yaml`);

      // Dropped here rather than by enumerating through `listActiveSpecs`,
      // which would read and parse the whole tree a second time to learn a
      // flag this parse already has.
      if (spec.disabled) return null;

      return {
        featureName,
        specName,
        title: spec.title,
        steps: describeSteps(spec, blocks, `${featureName}/${specName}`),
        includedBlocks: collectIncludedBlockNames(spec),
        testPath: resolveSpecTestPath(spec, config, featureName, specName),
        sourcePath: `.ccqa/features/${featureName}/test-cases/${specName}/spec.yaml`,
      };
    }),
  );
  return specs.filter((s): s is SpecDescription => s !== null);
}

/**
 * Same shape, for a project whose cases are its own markdown documents. No
 * `disabled` flag to drop here — that concept belongs to `spec.yaml`, and an
 * intent source has nothing that plays the same role.
 */
async function loadMarkdownInventory(
  intentTarget: IntentTarget,
  config: ProjectConfig,
  cwd: string,
): Promise<SpecDescription[]> {
  const { id: targetId, targetConfig, intent } = intentTarget;
  const target = registryFor(config).get(targetId)!;
  const ids = await listMarkdownCases(intent, cwd);
  return Promise.all(
    ids.map(async (caseId): Promise<SpecDescription> => {
      const testCase = await loadMarkdownCase(caseId, intent, cwd);
      const { featureName, specName } = splitCaseId(testCase.ref.id);
      return {
        featureName,
        specName,
        title: testCase.title,
        steps: describeMarkdownSteps(testCase),
        includedBlocks: [],
        testPath: runsLive(testCase) ? "" : resolveCaseTestPath(target, targetConfig, testCase.ref.id),
        sourcePath: markdownSourcePath(testCase, caseId, cwd),
      };
    }),
  );
}

/** The case's own file, project-root-relative, or its id when the source somehow isn't markdown. */
function markdownSourcePath(testCase: TestCase, id: string, cwd: string): string {
  return testCase.source.kind === "markdown" ? relative(cwd, testCase.source.path) : id;
}

/**
 * `--format paths` needs a real file to hand a test runner, so a target that
 * can't be resolved (bad `target:`/`defaultTarget`) degrades this one spec's
 * path to "" instead of failing the whole inventory — the other formats don't
 * depend on it. A live spec resolves to "" for the same reason: it is driven
 * from the spec every run and has compiled nothing a runner could take.
 */
function resolveSpecTestPath(
  spec: TestSpec,
  config: ProjectConfig,
  featureName: string,
  specName: string,
): string {
  if (spec.mode === "live") return "";
  try {
    const target = resolveTarget(spec, config);
    return resolveTestPath(target, targetConfigFor(config, target.id), { featureName, specName });
  } catch (e) {
    log.warn(`${featureName}/${specName}: could not resolve test path (${(e as Error).message})`);
    return "";
  }
}

/**
 * One line per step, with include steps expanded to the block's own steps —
 * the selection prompt is told to weigh shared login/navigation/layout
 * against each spec, which only works if those steps are actually visible
 * here rather than hidden behind a block name.
 *
 * Falls back to naming the block (the old behavior) when a block can't be
 * resolved, so one broken include degrades this spec's evidence rather than
 * failing selection for the whole inventory. Logged, not silent.
 */
function describeSteps(spec: TestSpec, blocks: Map<string, BlockSpec>, specKey: string): string[] {
  try {
    return expandSpec(spec, { blocks }).map(describeStepBody);
  } catch (e) {
    log.warn(`${specKey}: could not expand include steps (${(e as Error).message}) — showing block names instead`);
    return spec.steps.map(describeStep);
  }
}

function describeStep(step: Step): string {
  if (isIncludeStep(step)) return `include block: ${step.include}`;
  return describeStepBody(step);
}

function describeStepBody(step: AnyStepBody): string {
  if (isJudgeBody(step)) return `judge: ${oneLine(step.judgeByLlm)}`;
  return `${oneLine(step.instruction)} → ${oneLine(step.expected)}`;
}

/**
 * One line per step, in order — no `include:` to expand, since a markdown
 * case's steps are never block references. Unlike a spec step, a markdown
 * step carries no per-step `expected` (the case lists its expectations once,
 * for the whole flow), so only the instruction goes on the line.
 */
function describeMarkdownSteps(testCase: TestCase): string[] {
  return testCase.steps.map((step) =>
    isJudgeBody(step) ? `judge: ${oneLine(step.judgeByLlm)}` : oneLine(step.instruction),
  );
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
