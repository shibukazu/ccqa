import { substituteVars } from "../runtime/env-vars.ts";
import { parseTestSpec } from "./parser.ts";
import { isIncludeStep, isParamRequired, type BlockSpec, type Step, type TestSpec } from "./yaml-schema.ts";

/**
 * Flattened step from a spec, ready to feed into `ccqa trace`. Block includes
 * are expanded inline: each step inside a block becomes one entry with
 * `source: "<blockName>"` so the `// step:` comments downstream can show which
 * block the step came from, but the trace/replay path treats them as plain
 * spec steps. `$paramName` references inside the block's instruction/expected
 * are substituted with the values the include site provided.
 */
export interface ExpandedActionStep {
  id: string;
  /** "spec" for inline spec steps; the block name for steps that came from an include. */
  source: string;
  instruction: string;
  expected: string;
}

export interface ExpandOptions {
  /** Map of block name → parsed block. Missing blocks throw. */
  blocks: Map<string, BlockSpec>;
}

/**
 * Walk the spec's top-level steps, inlining any `- include: <block>` reference
 * as the block's own steps in order. The result is a flat `step-NN`-numbered
 * sequence — block boundaries survive only as the `source` tag, so trace and
 * codegen never need a separate block code path.
 */
export function expandSpec(spec: TestSpec, options: ExpandOptions): ExpandedActionStep[] {
  const out: ExpandedActionStep[] = [];
  let counter = 0;
  const allocId = (): string => {
    counter += 1;
    return `step-${String(counter).padStart(2, "0")}`;
  };

  for (const step of spec.steps) {
    if (isIncludeStep(step)) {
      const block = resolveBlock(step.include, step.params ?? {}, options.blocks);
      for (const blockStep of block.steps) {
        out.push({
          id: allocId(),
          source: step.include,
          instruction: substituteVars(blockStep.instruction, block.lookup),
          expected: substituteVars(blockStep.expected, block.lookup),
        });
      }
    } else {
      out.push({ id: allocId(), source: "spec", instruction: step.instruction, expected: step.expected });
    }
  }
  return out;
}

interface ResolvedBlock {
  steps: BlockSpec["steps"];
  lookup: (name: string) => string | undefined;
}

function resolveBlock(
  blockName: string,
  rawParams: Record<string, string>,
  blocks: Map<string, BlockSpec>,
): ResolvedBlock {
  const block = blocks.get(blockName);
  if (!block) {
    throw new Error(`Unknown block: "${blockName}". Define it under .ccqa/blocks/${blockName}/spec.yaml.`);
  }

  const declaredParams = new Map((block.params ?? []).map((p) => [p.name, p]));

  for (const key of Object.keys(rawParams)) {
    if (!declaredParams.has(key)) {
      throw new Error(
        `Block "${blockName}" received unknown param "${key}". ` +
          `Declared params: ${[...declaredParams.keys()].join(", ") || "(none)"}.`,
      );
    }
  }

  for (const [pname, def] of declaredParams) {
    if (isParamRequired(def) && !(pname in rawParams)) {
      throw new Error(`Block "${blockName}" is missing required param "${pname}".`);
    }
  }

  const lookup = (name: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(rawParams, name)) return rawParams[name];
    return undefined;
  };
  return { steps: block.steps, lookup };
}

/**
 * Collect every block name referenced by a spec (top-level only — blocks
 * cannot nest). Used by the store / drift layers to know which blocks to
 * load or invalidate.
 */
export function collectIncludedBlockNames(spec: TestSpec): string[] {
  const names = new Set<string>();
  for (const step of spec.steps) {
    if (isIncludeStep(step)) names.add(step.include);
  }
  return [...names];
}

/**
 * Best-effort variant for callers that only need the block list and don't
 * care to surface parse errors (e.g. `drift --changed` scoping, where a
 * malformed spec is reported separately by the main drift check). Returns
 * an empty array on any parse failure.
 */
export function tryCollectIncludedBlockNames(content: string): string[] {
  try {
    return collectIncludedBlockNames(parseTestSpec(content));
  } catch {
    return [];
  }
}

/** Re-export so other modules can discriminate raw schema steps too. */
export { isIncludeStep, type Step };
