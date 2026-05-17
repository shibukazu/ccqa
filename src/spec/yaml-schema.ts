import { z } from "zod";

/**
 * An action step: one user-facing browser interaction. `instruction` and
 * `expected` are the natural-language description handed to Claude during
 * `ccqa trace`. URLs live inside `instruction`, either verbatim or via
 * `${ENV_VAR}` references (resolved at runtime).
 */
export const ActionStepSchema = z
  .object({
    instruction: z.string().min(1),
    expected: z.string().min(1),
  })
  .strict();
export type ActionStep = z.infer<typeof ActionStepSchema>;

/**
 * An include step: invokes a reusable block (`.ccqa/blocks/<name>/spec.yaml`).
 * `params` values are plain strings; env refs (`${VAR}`) inside them are
 * resolved at expand time the same way step instructions are.
 */
export const IncludeStepSchema = z
  .object({
    include: z.string().min(1),
    params: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type IncludeStep = z.infer<typeof IncludeStepSchema>;

/**
 * A spec step is either an action step or an include step. The two are
 * discriminated by the presence of the `include` key — see `isIncludeStep`.
 */
export const StepSchema = z.union([ActionStepSchema, IncludeStepSchema]);
export type Step = z.infer<typeof StepSchema>;

/** Top-level spec schema. `.strict()` rejects any unknown key. */
export const TestSpecSchema = z
  .object({
    title: z.string().min(1),
    relatedPaths: z.array(z.string().min(1)).optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type TestSpec = z.infer<typeof TestSpecSchema>;

/**
 * A block param declaration. `required` defaults to true; only explicit
 * `required: false` makes it optional. `secret: true` flags the value as
 * sensitive — codegen renders such values as `process.env.<NAME> ?? ""`
 * template literals so the secret never ends up baked into test.spec.ts.
 * `dummy` is a placeholder value surfaced by the draft / drift prompts
 * (which see the block in isolation, before any include site exists);
 * `description` is the param's semantic role, also consumed by those
 * prompts and by spec authors browsing the block.
 */
export const BlockParamSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    dummy: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
export type BlockParam = z.infer<typeof BlockParamSchema>;

/**
 * Block schema. Block steps are restricted to ActionStep — nested blocks are
 * forbidden. Including a block from inside another block fails parsing here
 * (the store layer maps the cryptic "Unrecognized key: 'include'" error into
 * a targeted nested-block message).
 */
export const BlockSpecSchema = z
  .object({
    title: z.string().min(1),
    params: z.array(BlockParamSchema).optional(),
    steps: z.array(ActionStepSchema).min(1),
  })
  .strict();
export type BlockSpec = z.infer<typeof BlockSpecSchema>;

/** Runtime predicate for the StepSchema union. */
export function isIncludeStep(step: Step): step is IncludeStep {
  return "include" in step;
}

/** Returns true if a block param is required (default: true). */
export function isParamRequired(param: BlockParam): boolean {
  return param.required !== false;
}
