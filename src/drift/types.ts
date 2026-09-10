import { z } from "zod";
import {
  DriftDiagnosisSchema,
  DriftLabelSchema,
  DriftSubDiagnosisSchema,
  type DriftDiagnosis,
  type DriftLabel,
} from "../report/schema.ts";

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

/** The model's reply: a diagnosis, or `null` for "the spec still matches the code". */
export const DriftReplySchema = z.object({ drift: DriftDiagnosisSchema.nullable() });

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
