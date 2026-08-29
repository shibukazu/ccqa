import * as log from "../cli/logger.ts";
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
import { listAllSpecsWithSpecFile, loadAllBlocks, tryReadSpecFile } from "../store/index.ts";

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
}

/**
 * Read every drafted spec under `.ccqa/features/` into the shape the selection
 * prompt consumes. Specs without a spec file are skipped: there is nothing to
 * judge and nothing to run.
 *
 * Enumeration (`listAllSpecsWithSpecFile`, a directory walk) is kept separate
 * from reading and parsing each spec's own content, so every spec.yaml is
 * read and parsed exactly once — and the reads run in parallel.
 */
export async function loadSpecInventory(cwd: string): Promise<SpecDescription[]> {
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
      };
    }),
  );
  return specs.filter((s): s is SpecDescription => s !== null);
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

function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
