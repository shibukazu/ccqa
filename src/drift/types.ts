import { z } from "zod";
import {
  DriftDiagnosisSchema,
  DriftLabelSchema,
  DriftSubDiagnosisSchema,
  type DriftDiagnosis,
  type DriftLabel,
} from "../report/schema.ts";

// DriftLabelSchema / DriftSubDiagnosisSchema / DriftDiagnosisSchema live in
// report/schema.ts (not here) to avoid a schema cycle: ReportSpecResult's
// `driftAudit` field needs DriftDiagnosisSchema, and this module already
// imports FailureEvidenceSchema/PredictedLabelSchema/SUB_DIAGNOSES from
// there. Re-exported so existing callers of this module are unaffected.
export { DriftDiagnosisSchema, DriftLabelSchema, DriftSubDiagnosisSchema };
export type { DriftDiagnosis, DriftLabel };

export type Format = "text" | "json" | "github";
export type Threshold = "warn" | "error";

export interface SpecTarget {
  featureName: string;
  specName: string;
}

/** The model's reply: a diagnosis, or `null` for "the spec still matches the code". */
export const DriftReplySchema = z.object({
  drift: DriftDiagnosisSchema.nullable(),
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
}

/**
 * How a label reads against `--severity`. The threshold asks "would a
 * deterministic replay fail today", which is what the label already answers:
 * both findings mean the spec no longer describes the code, while `UNKNOWN`
 * means the audit could not tell and should not fail a build on its own.
 */
export function driftSeverity(label: DriftLabel): "error" | "warn" {
  return label === "UNKNOWN" ? "warn" : "error";
}
