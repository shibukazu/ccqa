import { z } from "zod";
import { SelectVerdictSchema } from "../hub/contract/schema.ts";

/**
 * Whether a spec has to be re-run after a set of source changes.
 *
 * Named for the action, matching the re-run vocabulary the hub already uses:
 * the question is "is the last result still trustworthy", not "how fresh is
 * this spec". `neverRun` / `notEvaluated` are ledger states and have no
 * meaning here — a diff alone cannot know whether a spec has ever run.
 *
 * Re-exported from the hub contract rather than declared here: this is the
 * same value the CLI serializes into `DeploySelectionEntry` when it reports a
 * selection to the hub, so the union has one source.
 */
export { SelectVerdictSchema };
export type SelectVerdict = z.infer<typeof SelectVerdictSchema>;

/**
 * How the verdict was reached. Kept because the two sources have different
 * trust: `mechanical` is set arithmetic on paths and cannot be wrong,
 * `model` is a judgement and can be.
 */
export const SelectSourceSchema = z.enum(["mechanical", "model"]);
export type SelectSource = z.infer<typeof SelectSourceSchema>;

export const SpecSelectionSchema = z.object({
  featureName: z.string().min(1),
  specName: z.string().min(1),
  verdict: SelectVerdictSchema,
  source: SelectSourceSchema,
  /** One sentence. For `needed`, names what about the change reaches this spec. */
  reason: z.string(),
  /** Changed paths tied to this spec. Set only for `needed`. */
  touchedBy: z.array(z.string()).optional(),
});
export type SpecSelection = z.infer<typeof SpecSelectionSchema>;

export const SelectReportSchema = z.object({
  /** The two commits the diff was taken between. */
  base: z.string(),
  head: z.string(),
  changedFiles: z.number().int().nonnegative(),
  /** Every spec in the tree, always — a spec absent from the diff is `notNeeded`, not omitted. */
  specs: z.array(SpecSelectionSchema),
});
export type SelectReport = z.infer<typeof SelectReportSchema>;

/** Specs the caller should actually run: everything not positively cleared. */
export function specsToRun(report: SelectReport): SpecSelection[] {
  return report.specs.filter((s) => s.verdict !== "notNeeded");
}

/**
 * One spec's verdict as the selection model's JSON reply states it, before
 * `touchedBy` is cross-checked against the actual diff.
 *
 * Parsed with `safeParse`, per element, rather than `z.array(...).parse` on
 * the whole reply: a model reply is untrusted input, and one malformed entry
 * (an invented verdict, a missing `spec` field) must not discard every other
 * spec's answer in the same reply. `touchedBy` keeps the same tolerance one
 * level down — a non-string element is dropped, not fatal to the entry.
 */
export const SelectRawAnswerSchema = z.object({
  spec: z.string(),
  verdict: SelectVerdictSchema,
  reason: z.string().default(""),
  touchedBy: z
    .array(z.unknown())
    .default([])
    .transform((paths) => paths.filter((p): p is string => typeof p === "string")),
});
export type SelectRawAnswer = z.infer<typeof SelectRawAnswerSchema>;

/** The selection model's reply shape: `{ specs: [...] }`, entries unvalidated at this level. */
export const SelectModelReplySchema = z.object({ specs: z.array(z.unknown()) });
