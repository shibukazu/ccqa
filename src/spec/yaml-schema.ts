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

/**
 * Execution mode for `ccqa run`:
 *   - `deterministic` (default): vitest replays the recorded `test.spec.ts`.
 *   - `live`: Claude drives agent-browser per step (for fragile UIs where
 *     codegen is impractical). Cost ~$0.5 per spec.
 */
export const SpecModeSchema = z.enum(["deterministic", "live"]);
export type SpecMode = z.infer<typeof SpecModeSchema>;

/**
 * A name a spec chooses that ccqa only ever compares or resolves to a path.
 * Restricted to a slug so it cannot escape a directory or collide with a key
 * whose separator is `/` or `:`.
 */
function slug(what: string) {
  return z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      `${what} must be a slug (letters, digits, '.', '_', '-'; no path separators)`,
    );
}

/** A field written as one name or a non-empty list, always read back as a list. */
function oneOrMany(name: z.ZodString) {
  return z.union([name, z.array(name).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));
}

/**
 * A saved browser session (cookies + localStorage) to restore before the spec
 * runs, resolved to `.ccqa/sessions/<profile>/<name>.json` at run time.
 */
export const SessionNameSchema = slug("session name");

/**
 * Sessions to restore before a `mode: live` spec runs. Multiple names are
 * merged (their cookies + localStorage are unioned) and restored together, so
 * a spec can start signed-in to several providers at once.
 */
export const SessionFieldSchema = oneOrMany(SessionNameSchema);

/**
 * Shared things this spec writes to, named. Two specs naming the same one
 * never run at the same time; specs with no name in common run in parallel.
 * The conflict is with the outside world, so this holds across targets and
 * modes.
 */
export const ExclusiveFieldSchema = oneOrMany(slug("exclusive name")).transform((names) =>
  // Compared, never resolved to a path, so `Channel` and `channel` naming the
  // same thing must not become two locks that never collide.
  names.map((n) => n.toLowerCase()),
);

/**
 * A generation-target id: which plugin turns this spec into runnable tests
 * (e.g. "agent-browser", "playwright", "runn"). Whether the id names a
 * registered target is the registry's responsibility, so new targets don't
 * require a schema change.
 */
export const TargetIdSchema = slug("target");

/** The built-in recorder-backed target. `mode:` / `session:` only apply to it. */
export const AGENT_BROWSER_TARGET = "agent-browser";

/**
 * Top-level spec schema. `.strict()` rejects any unknown key.
 *
 * `mode:` and `session:` are agent-browser-only fields, enforced here when
 * `target:` names another target. When `target:` is omitted the effective
 * target comes from config (`defaultTarget`, falling back to agent-browser),
 * which this schema can't see — so mode/session pass parsing and the
 * post-resolution check is the target resolver's responsibility.
 */
export const TestSpecSchema = z
  .object({
    title: z.string().min(1),
    /**
     * Generation target for this spec. Omitted means "use the project
     * config's `defaultTarget`" (agent-browser when that is absent too).
     */
    target: TargetIdSchema.optional(),
    mode: SpecModeSchema.optional(),
    /**
     * Saved browser session(s) to restore so a `mode: live` spec starts
     * already signed-in (see SessionFieldSchema for the name/merge mechanics).
     * Each name comes from `ccqa hub session capture <name>`; the state files are
     * restored read-only, so re-runs (local or CI) never mutate them. A missing
     * session stops the run with a bootstrap hint rather than running
     * unauthenticated. Ignored for deterministic specs — to log in normally,
     * omit `session` and do it in the steps.
     */
    session: SessionFieldSchema.optional(),
    /** Shared resources this spec writes to (see ExclusiveFieldSchema). */
    exclusive: ExclusiveFieldSchema.optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.target === undefined || spec.target === AGENT_BROWSER_TARGET) return;
    for (const key of ["mode", "session"] as const) {
      if (spec[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `\`${key}\` only applies to the agent-browser target — remove it or drop \`target: ${spec.target}\``,
        });
      }
    }
  });
export type TestSpec = z.infer<typeof TestSpecSchema>;

/** Default mode when `mode:` is absent. */
export const DEFAULT_SPEC_MODE: SpecMode = "deterministic";

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
