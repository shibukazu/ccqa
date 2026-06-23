import { z } from "zod";
import { SpecModeSchema } from "./yaml-schema.ts";

/**
 * `perspectives.yaml` is an inventory of the test coverage that already
 * exists under `.ccqa/` — the ccqa equivalent of a hand-kept QA spreadsheet,
 * but scoped deliberately to *facts about what is tested today*.
 *
 * It intentionally does NOT carry severity / importance / priority. Deciding
 * "how badly does it hurt the customer if this breaks" is a human + PdM
 * decision, not something ccqa should author or silently overwrite. Keeping
 * those columns out of the schema (and `.strict()` rejecting them) makes the
 * boundary explicit: perspectives is a factual stock-take, severity lives
 * wherever the team decides on it.
 *
 * It also does NOT attempt code-vs-test gap analysis (listing untested
 * areas). A flat dump of "things in code with no test" is noise without
 * prioritisation; that is a separate, later concern.
 */

/**
 * Mechanically-derived facts about the spec's recording state, transcribed by
 * the CLI from spec.yaml + on-disk artifacts (actions.json / test.spec.ts).
 * Never written by Claude — these must not drift.
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
 */
export const PerspectiveStatusSchema = z
  .object({
    mode: SpecModeSchema,
    traced: z.boolean(),
    generated: z.boolean(),
  })
  .strict();
export type PerspectiveStatus = z.infer<typeof PerspectiveStatusSchema>;

/**
 * One test case in the inventory.
 *
 * - `title` / `relatedPaths` are transcribed verbatim from the spec.yaml.
 * - `status` is mechanically derived (see PerspectiveStatusSchema).
 * - `summary` is a 1–2 sentence description of *what the spec verifies*,
 *   derived from its steps by Claude.
 * - `startScreen` / `testCondition` / `preconditions` mirror the columns a
 *   hand-kept QA table carries. They are Claude-derived from the spec's
 *   steps (the opening screen, the state the test assumes, and the setup
 *   prerequisites such as which role logs in). Optional: a spec may not
 *   express all of them.
 * - `note` is a human-only field. Regenerating perspectives preserves it.
 *
 * The detailed test procedure and expected results are deliberately NOT
 * duplicated here — the spec.yaml steps are the single source of truth for
 * those. The Markdown view links back to the spec instead of restating them.
 */
export const PerspectiveSpecSchema = z
  .object({
    specName: z.string().min(1),
    title: z.string().min(1),
    summary: z.string(),
    startScreen: z.string().optional(),
    testCondition: z.string().optional(),
    preconditions: z.array(z.string().min(1)).optional(),
    relatedPaths: z.array(z.string().min(1)).optional(),
    status: PerspectiveStatusSchema,
    note: z.string().optional(),
  })
  .strict();
export type PerspectiveSpec = z.infer<typeof PerspectiveSpecSchema>;

export const PerspectiveFeatureSchema = z
  .object({
    featureName: z.string().min(1),
    specs: z.array(PerspectiveSpecSchema),
  })
  .strict();
export type PerspectiveFeature = z.infer<typeof PerspectiveFeatureSchema>;

/** Top-level perspectives schema. `.strict()` rejects any unknown key. */
export const PerspectivesSchema = z
  .object({
    generatedAt: z.string().optional(),
    features: z.array(PerspectiveFeatureSchema),
  })
  .strict();
export type Perspectives = z.infer<typeof PerspectivesSchema>;
