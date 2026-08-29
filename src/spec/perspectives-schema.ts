import { z } from "zod";
import { SpecModeSchema } from "./yaml-schema.ts";

/**
 * `perspectives.yaml` is an inventory of the test coverage that already
 * exists under `.ccqa/` — the ccqa equivalent of a hand-kept QA spreadsheet,
 * but scoped deliberately to *facts about what is tested today*.
 *
 * It intentionally does NOT carry severity / importance / priority. Deciding
 * "how badly does it hurt the customer if this breaks" is a human + PdM
 * decision, not something ccqa should author or silently overwrite. Those
 * columns are simply absent from the schema: perspectives is a factual
 * stock-take, severity lives wherever the team decides on it.
 *
 * It also does NOT attempt code-vs-test gap analysis (listing untested
 * areas). A flat dump of "things in code with no test" is noise without
 * prioritisation; that is a separate, later concern.
 *
 * **Forward-compat: these document schemas STRIP unknown keys, never reject.**
 * The perspectives document is shared on the hub and read by whatever CLI
 * versions a team runs. A `.strict()` reject would brick every older reader
 * the moment a newer CLI adds an additive field (the `status.target` field
 * added in this change already caused one such break for ≤1.6 readers — see
 * the PR notes). Stripping means an old reader silently ignores a field it
 * doesn't know rather than hard-failing the whole document.
 */

/**
 * Mechanically-derived facts about the spec's recording state, transcribed by
 * the CLI from spec.yaml + on-disk artifacts. Never written by Claude — these
 * must not drift.
 *
 * `mode` mirrors spec.yaml's `mode:` field (defaulting to `deterministic`).
 * Its meaning shapes how `traced` / `generated` should be interpreted:
 *
 *  - `mode: deterministic` — `traced` and `generated` are the spec's
 *    completeness signal. `generated: false` means "spec.yaml exists but
 *    `ccqa record` hasn't been run yet" — i.e. the case has not been
 *    materialised into a runnable test.
 *  - `mode: live` — the live runner skips codegen entirely, so `traced` and
 *    `generated` carry no completeness meaning here. Reports should not flag
 *    `generated: false` as incomplete for live specs.
 *
 * `traced` / `generated` are interpreted through the spec's generation
 * `target`, which is why the resolved id is carried here:
 *
 *  - agent-browser (the default; `target` omitted for byte-compatible docs):
 *    `traced` = an `ir.json` recording exists, `generated` = a `test.spec.ts`
 *    exists.
 *  - a recording-input external target (e.g. `playwright`): same `traced`
 *    (record still produces `ir.json`), but `generated` = the target's
 *    `generated.json` manifest exists.
 *  - a spec-input external target (e.g. `runn`): there is no record phase, so
 *    `traced` is always true (nothing to trace is not a coverage gap), and
 *    `generated` again means the `generated.json` manifest exists.
 *
 * `target` is set only for non-agent-browser specs, so an all-default project
 * produces exactly the pre-existing document shape.
 */
export const PerspectiveStatusSchema = z
  .object({
    mode: SpecModeSchema,
    traced: z.boolean(),
    generated: z.boolean(),
    /** Resolved generation-target id; omitted for the default agent-browser target. */
    target: z.string().min(1).optional(),
  })
  .strip();
export type PerspectiveStatus = z.infer<typeof PerspectiveStatusSchema>;

/**
 * One step of a spec, transcribed verbatim for display. Exactly one shape per
 * step: an include step carries the block name it invokes (its params stay in
 * the spec — they are wiring, not procedure), an action step carries the
 * instruction and what it expects. Never authored or reworded here: like
 * `title`, this is a mechanical copy the next `ccqa perspectives` rewrites.
 */
export const PerspectiveStepSchema = z
  .object({
    /** Present on an include step: the block it invokes. */
    include: z.string().min(1).optional(),
    instruction: z.string().optional(),
    expected: z.string().optional(),
  })
  .strip();
export type PerspectiveStep = z.infer<typeof PerspectiveStepSchema>;

/**
 * One test case in the inventory.
 *
 * - `title` is transcribed verbatim from the spec.yaml.
 * - `status` is mechanically derived (see PerspectiveStatusSchema).
 * - `summary` is a 1–2 sentence description of *what the spec verifies*,
 *   derived from its steps by Claude.
 * - `startScreen` / `testCondition` / `preconditions` mirror the columns a
 *   hand-kept QA table carries. They are Claude-derived from the spec's
 *   steps (the opening screen, the state the test assumes, and the setup
 *   prerequisites such as which role logs in). Optional: a spec may not
 *   express all of them.
 * - `steps` is the procedure itself, transcribed verbatim (never authored —
 *   see PerspectiveStepSchema) so the hub UI can show a case in full without
 *   a repo checkout. The spec.yaml stays the single source of truth: this
 *   copy is rewritten wholesale every time the inventory is regenerated, the
 *   same way `title` is.
 * - `note` is a human-only field. Regenerating perspectives preserves it.
 */
export const PerspectiveSpecSchema = z
  .object({
    specName: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
    startScreen: z.string().optional(),
    testCondition: z.string().optional(),
    preconditions: z.array(z.string().min(1)).optional(),
    steps: z.array(PerspectiveStepSchema).optional(),
    status: PerspectiveStatusSchema,
    /**
     * When this spec was last edited (committer date, ISO 8601). Lets the hub
     * treat an audit or a run as stale once the spec itself has moved — the
     * deploy log only says when the *product* moved. Optional: a document
     * written by an older CLI has none, and every reader falls back to the
     * deploy-only comparison it used before.
     */
    changedAt: z.string().optional(),
    /**
     * The spec is in the tree but opted out of runs and audits (`disabled:`
     * in its spec.yaml). It stays listed so the inventory keeps showing it and
     * its `note` survives — dropping it would take the one piece of history
     * that lives only here. Absent means enabled, so a document written by an
     * older CLI reads the way it always did.
     */
    disabled: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strip();
export type PerspectiveSpec = z.infer<typeof PerspectiveSpecSchema>;

export const PerspectiveFeatureSchema = z
  .object({
    featureName: z.string().min(1),
    specs: z.array(PerspectiveSpecSchema),
  })
  .strip();
export type PerspectiveFeature = z.infer<typeof PerspectiveFeatureSchema>;

/** Top-level perspectives schema. Unknown keys are stripped, not rejected (see header). */
export const PerspectivesSchema = z
  .object({
    generatedAt: z.string().optional(),
    features: z.array(PerspectiveFeatureSchema),
  })
  .strip();
export type Perspectives = z.infer<typeof PerspectivesSchema>;
