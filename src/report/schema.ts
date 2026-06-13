import { z } from "zod";
import { FIXABLE_DIAGNOSIS_TYPES } from "../diagnose/types.ts";
import { DraftIssueSchema } from "../types.ts";

/**
 * The three-way root-cause call for a failing spec, framed as drift analysis:
 *  - TEST_DRIFT:  what the spec verifies is unchanged; only the test code
 *                 drifted from the source (selector rename, timing, ...).
 *                 Future iterations may auto-fix these.
 *  - SPEC_CHANGE: the thing being verified itself changed (UI redesign,
 *                 spec change). Never auto-fix — a human must re-draft.
 *  - PRODUCT_BUG: neither of the above explains the failure — treat it as
 *                 a product regression.
 *
 * The stakeholder ask behind this module is measurement-first: the call is
 * known to be hard, so every prediction is embedded in the HTML report where
 * a human records the ground truth and the report computes the confusion
 * matrix client-side. Accuracy may start low; it must be *visible*.
 */
export const FAILURE_LABELS = ["TEST_DRIFT", "SPEC_CHANGE", "PRODUCT_BUG"] as const;
export const FailureLabelSchema = z.enum(FAILURE_LABELS);
export type FailureLabel = z.infer<typeof FailureLabelSchema>;

/** What the model may answer: the three labels, or UNKNOWN when evidence is weak. */
export const PREDICTED_LABELS = [...FAILURE_LABELS, "UNKNOWN"] as const;
export const PredictedLabelSchema = z.enum(PREDICTED_LABELS);
export type PredictedLabel = z.infer<typeof PredictedLabelSchema>;

export const SUB_DIAGNOSES = [...FIXABLE_DIAGNOSIS_TYPES, "NONE"] as const;

export const FailureEvidenceSchema = z.object({
  /** file:line or diff-hunk reference backing the claim. Optional for log-only evidence. */
  file: z.string().optional(),
  detail: z.string(),
});
export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;

/**
 * LLM output shape. Deliberately NOT .strict(): the model occasionally adds
 * keys, and rejecting the whole analysis over an extra field would collapse
 * a usable prediction into UNKNOWN. Zod's default strips unknown keys.
 */
export const FailureAnalysisSchema = z.object({
  label: PredictedLabelSchema,
  confidence: z.number().min(0).max(1),
  /**
   * Finer-grained vocabulary borrowed from the generate-time diagnose loop.
   * Free measurement signal today; the bridge back into diagnose/apply.ts
   * when TEST_DRIFT precision is proven high enough to auto-fix.
   */
  subDiagnosis: z.enum(SUB_DIAGNOSES).optional(),
  evidence: z.array(FailureEvidenceSchema),
  reasoning: z.string(),
});
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;

export const ReportAssertionSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().nullable(),
});
export type ReportAssertion = z.infer<typeof ReportAssertionSchema>;

export const ReportSpecResultSchema = z.object({
  feature: z.string(),
  spec: z.string(),
  status: z.enum(["passed", "failed"]),
  /** "3/4 passed" style detail from the vitest JSON report, when available. */
  testCounts: z
    .object({ total: z.number(), passed: z.number(), failed: z.number() })
    .nullable(),
  /** Sum of assertion durations, when the vitest JSON report is available. */
  durationMs: z.number().nullable(),
  /** Per-test rows from the vitest JSON report (Playwright-style step list). */
  assertions: z.array(ReportAssertionSchema).nullable(),
  /** Present only for failed specs that were analyzed. */
  analysis: FailureAnalysisSchema.nullable(),
  /** Human-readable reason when a failed spec was NOT analyzed (no auth, no spec.yaml, ...). */
  analysisSkipped: z.string().nullable(),
  /** Existing spec↔code drift audit findings (analyzeDrift), shown as supporting context. */
  driftIssues: z.array(DraftIssueSchema).nullable(),
  failureLogExcerpt: z.string().nullable(),
  diffExcerpt: z.string().nullable(),
  specYaml: z.string().nullable(),
});
export type ReportSpecResult = z.infer<typeof ReportSpecResultSchema>;

export const RunReportDataSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  /** GITHUB_RUN_ID when running in Actions; null locally. Links the report back to its CI run. */
  runId: z.string().nullable(),
  git: z.object({
    head: z.string().nullable(),
    /** Resolved --drift-base ref; null when the diff could not be captured. */
    base: z.string().nullable(),
  }),
  model: z.string().nullable(),
  /**
   * ANALYSIS_PROMPT_VERSION at generation time. Lets exported labels be
   * compared apples-to-apples across prompt iterations.
   */
  promptVersion: z.string(),
  results: z.array(ReportSpecResultSchema),
});
export type RunReportData = z.infer<typeof RunReportDataSchema>;

/** Shape of the "export labels" download produced by the report's client-side JS. */
export const LabelEntrySchema = z.object({
  feature: z.string(),
  spec: z.string(),
  predicted: PredictedLabelSchema,
  label: FailureLabelSchema,
  note: z.string().optional(),
});
export type LabelEntry = z.infer<typeof LabelEntrySchema>;

export const LabelsExportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().nullable(),
  promptVersion: z.string(),
  exportedAt: z.string(),
  labels: z.array(LabelEntrySchema),
});
export type LabelsExport = z.infer<typeof LabelsExportSchema>;
