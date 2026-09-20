import { relative } from "node:path";
import * as log from "../cli/logger.ts";
import { runsLive } from "../cli/live-case.ts";
import type { TestCase } from "../cases/case.ts";
import { openCaseReader, type CaseReader } from "../cases/reader.ts";
import { loadProjectConfig, targetConfigFor, type ProjectConfig } from "../config/project-config.ts";
import { collectIncludedBlockNames, isJudgeBody, type AnyStepBody } from "../spec/expand.ts";
import { registryFor, resolveTarget } from "../targets/registry.ts";
import { resolveCaseRecordingPath, resolveCaseTestPath } from "../targets/test-path.ts";
import { splitCaseId } from "../store/index.ts";

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
  /**
   * Project-root-relative path of this case's recording, resolved through the
   * same target as `testPath`. Empty on the same terms. Editing it is a change
   * to what the case does, which no measured reach can see — `partitionChanges`
   * matches a changed file against this the way it matches `sourcePath`.
   */
  recordingPath: string;
}

/**
 * Read every test case the project states into the shape the selection prompt
 * consumes — ccqa's own specs, or the documents the project writes itself,
 * whichever this project has. One enumeration, one read per case, through the
 * one reader: what the two kinds share is everything the prompt is shown.
 */
export async function loadSpecInventory(cwd: string): Promise<SpecDescription[]> {
  const config = await loadProjectConfig(cwd);
  const reader = openCaseReader(config, cwd);
  const ids = await reader.list();
  const described = await Promise.all(
    ids.map(async (id): Promise<SpecDescription | null> => {
      // Read, not loaded: a case ccqa cannot act on is still a case this
      // command must weigh. Dropping it would clear it on no evidence, which
      // is the one outcome selection must never produce — so a blocked case
      // keeps its place with the steps its document writes.
      const read = await reader.read(id);
      // A document that will not parse has no steps to judge, and the model,
      // given only a name, answers `notNeeded` as confidently as if it had
      // read one. So this one does stop the command.
      if (read.case === null) throw new Error(read.error ?? `${id}: could not be read`);
      const testCase = read.case;
      if (testCase.blocked !== null) log.warn(`${id}: ${testCase.blocked}`);
      if (testCase.disabled) return null;
      const { featureName, specName } = splitCaseId(testCase.ref.id);
      return {
        featureName,
        specName,
        title: testCase.title,
        steps: testCase.steps.map(describeStepBody),
        includedBlocks: testCase.spec ? collectIncludedBlockNames(testCase.spec) : [],
        ...resolveCasePaths(testCase, config, reader),
        sourcePath: relative(cwd, testCase.document.path),
      };
    }),
  );
  return described.filter((s): s is SpecDescription => s !== null);
}

/**
 * `--format paths` needs a real file to hand a test runner, so a target that
 * can't be resolved (bad `target:`/`defaultTarget`) degrades this one case's
 * path to "" instead of failing the whole inventory — the other formats don't
 * depend on it. A live case resolves to "" for the same reason: it is driven
 * from the document every run and has compiled nothing a runner could take.
 */
function resolveCasePaths(
  testCase: TestCase,
  config: ProjectConfig,
  reader: CaseReader,
): { testPath: string; recordingPath: string } {
  const none = { testPath: "", recordingPath: "" };
  if (runsLive(testCase)) return none;
  try {
    const owner = reader.target;
    const target = owner
      ? registryFor(config).get(owner.id)!
      : resolveTarget(testCase.spec!, config);
    const targetConfig = owner ? owner.targetConfig : targetConfigFor(config, target.id);
    return {
      testPath: resolveCaseTestPath(target, targetConfig, testCase.ref.id),
      recordingPath: resolveCaseRecordingPath(target, targetConfig, testCase.ref.id),
    };
  } catch (e) {
    log.warn(`${testCase.ref.id}: could not resolve test path (${(e as Error).message})`);
    return none;
  }
}

/**
 * One line per step, in order. Include steps arrive already expanded to the
 * block's own steps — the selection prompt is told to weigh shared
 * login/navigation/layout against each case, which only works if those steps
 * are actually visible here rather than hidden behind a block name.
 *
 * A step with no `expected` of its own prints as the instruction alone: a case
 * that states its expectations once for the whole flow has nothing to put
 * after the arrow, and an empty one reads as a step that checks nothing.
 */
function describeStepBody(step: AnyStepBody): string {
  if (isJudgeBody(step)) return `judge: ${oneLine(step.judgeByLlm)}`;
  const expected = oneLine(step.expected);
  const instruction = oneLine(step.instruction);
  return expected.length > 0 ? `${instruction} → ${expected}` : instruction;
}

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
