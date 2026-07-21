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
 * known to be hard, so every prediction is carried in report.json where the
 * hub UI lets a human record the ground truth and computes the confusion
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
 *
 * The report renders `headline` + `evidence` + `recommendation` as the primary
 * three-line summary; `reasoning` is kept for backward compatibility / deep
 * dive and hidden behind a collapsed details panel.
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
  /** Single-sentence conclusion. What broke, in one line a reviewer can scan. */
  headline: z.string().default(""),
  /** Concrete next action the human should take. One imperative sentence. */
  recommendation: z.string().default(""),
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

/**
 * Step-boundary evidence captured at runtime by abStepEvidence() for the
 * deterministic test path (`ccqa run --drift-report`). The path fields are
 * relative to the report directory so consumers (the hub UI, CI tooling) can
 * resolve the PNGs without duplicating their (potentially large) bytes inline.
 */
export const ReportEvidenceSchema = z.object({
  stepId: z.string(),
  source: z.string(),
  pngPath: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  capturedAt: z.string().nullable(),
  /**
   * Short text used as a caption supplement, sourced from the spec.yaml's
   * `expected`. For block include sites the expanded `expected` is stored.
   * `null` when the spec could not be resolved (spec.yaml missing, etc).
   */
  description: z.string().nullable(),
  /** "passed" when the step ran to completion; "failed" when fail() captured it mid-step. */
  status: z.enum(["passed", "failed"]).default("passed"),
  /** Assertion summary from fail(). Present only for failed steps. */
  failureSummary: z.string().nullable().default(null),
});
export type ReportEvidence = z.infer<typeof ReportEvidenceSchema>;

/**
 * A file collected from an external (runCommand) target's execution — the
 * command's output log plus whatever the run left in the spec's artifacts
 * directory (screenshots, traces, result JSON). `path` is relative to the
 * report directory (same convention as `ReportEvidenceSchema.pngPath`), so
 * the report directory stays self-contained. `kind` is inferred from the
 * file extension and only steers rendering (inline image / inline text /
 * download link). agent-browser rows keep their runner-specific `evidence` /
 * `liveRun` fields instead.
 */
export const ARTIFACT_KINDS = ["image", "text", "json", "binary"] as const;
export const ReportArtifactSchema = z.object({
  /** Display name: the path within the spec's artifacts dir (the bare file name for top-level files). */
  name: z.string(),
  /** Report-directory-relative posix path. */
  path: z.string(),
  kind: z.enum(ARTIFACT_KINDS),
  sizeBytes: z.number(),
});
export type ReportArtifact = z.infer<typeof ReportArtifactSchema>;

/**
 * Per-step row for a live-mode run (spec.yaml `mode: live`). Mirrors the
 * structure produced by `src/runtime/live-executor.ts:LiveStepResult` but
 * encoded against the report schema so the HTML renderer can carry both
 * deterministic (`evidence`) and live (`liveRun`) sources of step-boundary
 * screenshots.
 *
 * `beforePng` / `afterPng` are RELATIVE to the report directory, same
 * convention as `ReportEvidenceSchema.pngPath` above. The caller copies the
 * PNG files into `<reportDir>/evidence/<feature>/<spec>/` and computes the
 * relative path with `node:path`'s `relative()`, so the report directory is
 * self-contained: it can be archived and shipped on its own (e.g. a hub
 * push) without also bundling the `.ccqa` runs dir.
 */
/**
 * Per-step / per-run cost+usage record, pulled from the SDK's `result` message.
 * Every numeric field is nullable so the report can carry partial telemetry
 * (e.g. when the SDK omits a field, or when a step was skipped).
 *
 * `models` is the union of model ids the SDK reported using; usually a
 * single element, but the SDK can fan out across models in some modes.
 */
export const LiveReportCostSchema = z.object({
  totalCostUsd: z.number().nullable(),
  durationApiMs: z.number().nullable(),
  numTurns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  models: z.array(z.string()),
});
export type LiveReportCost = z.infer<typeof LiveReportCostSchema>;

export const LiveReportStepSchema = z.object({
  stepId: z.string(),
  source: z.string(),
  instruction: z.string(),
  expected: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  reasoning: z.string(),
  beforePng: z.string().nullable(),
  afterPng: z.string().nullable(),
  durationMs: z.number(),
  cost: LiveReportCostSchema,
  /**
   * agent-browser commands Claude issued on the accepted attempt (tail-trimmed).
   * Optional for backward compatibility with reports written before this field
   * existed. Consumed by the live prompt-learning summary as the concrete
   * shortcut a later run can reuse instead of re-exploring.
   */
  commands: z.array(z.string()).optional(),
});
export type LiveReportStep = z.infer<typeof LiveReportStepSchema>;

export const LiveReportRunSchema = z.object({
  runId: z.string(),
  sessionName: z.string(),
  startedAt: z.string(),
  durationMs: z.number(),
  steps: z.array(LiveReportStepSchema),
  cost: LiveReportCostSchema,
});
export type LiveReportRun = z.infer<typeof LiveReportRunSchema>;

export const ReportSpecResultSchema = z.object({
  feature: z.string(),
  spec: z.string(),
  /**
   * Human-readable spec title from spec.yaml. Shown as the primary identifier
   * in the report so reviewers see "what was tested" instead of just the
   * `<feature>/<spec>` slug. `null` when spec.yaml is unavailable.
   */
  title: z.string().nullable(),
  /**
   * Generation-target id this row ran under: "agent-browser" for the built-in
   * det/live paths, the plugin id ("playwright", "runn", ...) for external
   * runCommand rows. Optional so reports written before this field existed
   * stay valid; unset when the target could not be determined at all.
   */
  target: z.string().optional(),
  /**
   * "skipped" marks a spec that could not execute at all (e.g. it belongs to
   * a generate-only target with no `runCommand`); `skipReason` says why.
   */
  status: z.enum(["passed", "failed", "skipped"]),
  /** Why the spec did not execute. Present only for "skipped" rows. */
  skipReason: z.string().optional(),
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
  /**
   * The baseline THIS spec's diff was taken against. Matches the envelope's
   * git.base for fixed baselines; under `--failure-analysis=last-green` each
   * spec has its own (the commit where it last passed). Optional so older
   * report.json stays valid; absent when no diff context was resolved.
   */
  analysisBase: z.object({ ref: z.string(), sha: z.string() }).nullable().optional(),
  /** Existing spec↔code drift audit findings (analyzeDrift), shown as supporting context. */
  driftIssues: z.array(DraftIssueSchema).nullable(),
  failureLogExcerpt: z.string().nullable(),
  diffExcerpt: z.string().nullable(),
  specYaml: z.string().nullable(),
  /** Step-boundary screenshots for the deterministic (`ccqa run`) path, in capture order. */
  evidence: z.array(ReportEvidenceSchema).nullable(),
  /**
   * Generic run artifacts for external (runCommand) target specs: the
   * command's `output.log` plus whatever it wrote into `{artifactsDir}`.
   * Optional (not nullable) so report.json written before this field existed
   * stays valid byte-for-byte.
   */
  artifacts: z.array(ReportArtifactSchema).optional(),
  /**
   * Set for specs executed in live mode (`mode: live`). The renderer shows the
   * per-step verdicts + before/after screenshots instead of (or in addition
   * to) the vitest assertion list. `assertions` is null for live-only specs.
   */
  liveRun: LiveReportRunSchema.nullable(),
});
export type ReportSpecResult = z.infer<typeof ReportSpecResultSchema>;

export const RunReportDataSchema = z.object({
  schemaVersion: z.literal(1),
  /** "run" = ccqa run/live execution result; "drift" = ccqa drift --push. */
  kind: z.enum(["run", "drift"]).default("run"),
  createdAt: z.string(),
  /** GITHUB_RUN_ID when running in Actions; null locally. Links the report back to its CI run. */
  runId: z.string().nullable(),
  git: z.object({
    /**
     * Full HEAD sha, recorded unconditionally (independent of whether a diff
     * was captured). Null only when the run executed outside a git repo, or
     * for report.json written before this guarantee existed.
     */
    head: z.string().nullable(),
    /**
     * The failure-analysis baseline ref (`--failure-analysis [base]`); null
     * when analysis was not requested.
     */
    base: z.string().nullable(),
    /**
     * `base` resolved to a full commit sha at run start — the reproducible
     * form of the baseline (`origin/main` alone can't be re-resolved later).
     * Optional so older report.json stays valid.
     */
    baseSha: z.string().nullable().optional(),
    /**
     * Which rule produced `base`: "explicit" (a value was passed),
     * "github-base-ref" (derived from a pull_request event), or "last-green"
     * (per-spec baselines from the hub ledger — `baseSha` is then null and
     * each analyzed row carries its own `analysisBase`). Lets accuracy
     * numbers be stratified by baseline provenance. Optional for older
     * report.json.
     */
    baseSource: z.enum(["explicit", "github-base-ref", "last-green"]).nullable().optional(),
  }),
  model: z.string().nullable(),
  /**
   * BCP-47 tag the report's UI chrome should be rendered in. The model-driven
   * fields (headline/recommendation/reasoning) are already localised via the
   * prompt's outputLanguage; this controls labels, button text, help bubbles.
   * null falls back to English.
   */
  language: z.string().nullable().default(null),
  /**
   * ANALYSIS_PROMPT_VERSION at generation time. Lets exported labels be
   * compared apples-to-apples across prompt iterations.
   */
  promptVersion: z.string(),
  /**
   * The analysis custom prompt version applied to this run's failure analysis, or
   * null when none was active (base prompt only). Lets accuracy be compared
   * across custom prompt iterations. `.default(null)` keeps older report.json valid.
   */
  customPromptVersion: z.string().nullable().default(null),
  /**
   * Short content hash of the human-maintained `triage.user` hub prompt
   * injected into this run's failure analysis. The Markdown body has no
   * version of its own, so the hash is the stratification key across guidance
   * edits. Absent (not null) when no user prompt was active, which keeps the
   * envelope byte-identical to before this field existed.
   */
  triageUserPromptHash: z.string().optional(),
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
