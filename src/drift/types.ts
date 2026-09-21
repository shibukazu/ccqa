import { z } from "zod";
import {
  DriftDiagnosisSchema,
  DriftLabelSchema,
  DriftSubDiagnosisSchema,
  type DriftDiagnosis,
  type DriftLabel,
} from "../report/schema.ts";
import { RenameSchema, type AuditedRename, type Rename } from "./renames.ts";

// DriftLabelSchema / DriftSubDiagnosisSchema / DriftDiagnosisSchema live in
// report/schema.ts (not here): they belong to the failure-cause vocabulary
// this module already imports from there. `DriftLabelSchema` is that whole
// vocabulary today — what separates an audit's answer from a run's is
// `driftSeverity` below, not a narrower set of labels.
export { DriftDiagnosisSchema, DriftLabelSchema, DriftSubDiagnosisSchema };
export type { DriftDiagnosis, DriftLabel };

export type Format = "text" | "json" | "github";
export type Threshold = "warn" | "error";

export interface SpecTarget {
  featureName: string;
  specName: string;
  /**
   * Set when the case is stated in the project's own document rather than in
   * ccqa's `spec.yaml`. `featureName`/`specName` are that id split, so a report
   * row addresses a markdown case exactly the way it addresses any other.
   */
  caseId?: string;
}

/** How everything downstream spells this case: its intent-source id, or `feature/spec`. */
export function caseIdOf(target: SpecTarget): string {
  return target.caseId ?? `${target.featureName}/${target.specName}`;
}

/**
 * What the audit says about one locator code could not find in the product.
 *
 * `drifted` says the test asks for something the product no longer renders;
 * `fine` says the miss has another explanation — a selector built at runtime, a
 * component this case never reaches, a file the scan did not read. Either is an
 * answer; silence is not, which is what the required list below is for.
 */
export const LocatorVerdictSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["drifted", "fine"]),
  note: z.string().default(""),
});
export type LocatorVerdict = z.infer<typeof LocatorVerdictSchema>;

/** The model's reply: a diagnosis, or `null` for "the spec still matches the code". */
export const DriftReplySchema = z.object({
  drift: DriftDiagnosisSchema.nullable(),
  /** Present when the audit was handed locators to check. See `checkLocatorVerdicts`. */
  locators: z.array(LocatorVerdictSchema).default([]),
  /**
   * Renamed strings, when the audit found any. Forgiven one element at a time:
   * these help a repair land, so a malformed pair must cost neither its valid
   * siblings nor the verdict the sweep already paid for.
   */
  renames: z
    .array(RenameSchema.nullable().catch(null))
    .transform((rs) => rs.filter((r): r is Rename => r !== null))
    .default([])
    .catch([]),
});

export interface SpecResult {
  target: SpecTarget;
  ok: boolean;
  /** Null when spec and code agree — the absence of a finding, not a verdict of "fine". */
  drift: DriftDiagnosis | null;
  /** Filled when the LLM call itself failed (network, parse, etc.). */
  error?: string;
  /**
   * What the audit read, carried through to the report. A deterministic spec
   * has two surfaces to check and a live one has a single surface, so this is
   * not decoration — it says how much of the test case was examined. Absent
   * when the spec could not be read at all.
   */
  live?: boolean;
  title?: string | null;
  /**
   * The document this case is stated in, relative to the project root. Carried
   * rather than derived: where a case is filed is the project's business, and
   * a GitHub annotation pointing at a `spec.yaml` that does not exist annotates
   * nothing. Absent when the case could not be read at all.
   */
  documentPath?: string;
  /**
   * Renamed strings the audit named, sanitized and each carrying whether this
   * case's document holds it (`auditedRenames`). Beside the diagnosis rather
   * than in it: they are an aid to the repair, not part of the verdict.
   */
  renames?: AuditedRename[];
}

/**
 * How a label reads against `--exit-on`. The threshold asks "would a
 * deterministic replay fail today". `TEST_DRIFT` and `SPEC_CHANGE` answer yes
 * and name the repair, so they hold the gate shut. The other three do not: a
 * suspected product bug or a dependency on data the source does not decide is
 * settled by running the case, not by refusing to run it, and `UNKNOWN` says
 * the audit could not tell.
 */
export function driftSeverity(label: DriftLabel): "error" | "warn" {
  return label === "TEST_DRIFT" || label === "SPEC_CHANGE" ? "error" : "warn";
}
