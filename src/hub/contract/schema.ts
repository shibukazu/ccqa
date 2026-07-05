import { z } from "zod";
import { FailureLabelSchema, PredictedLabelSchema } from "../../report/schema.ts";

/**
 * The hub's public REST contract (docs/hub-api.md). These schemas are
 * consumed on both sides of the wire: the hub validates request/response
 * bodies against them, and `ccqa/hub-client` re-exports them so any HTTP
 * client — the ccqa CLI, an intranet web app, the hub's own bundled UI —
 * gets the same types.
 */

/**
 * A run's outcome. The hub never executes — a run is created when a client
 * pushes the report of an already-finished `ccqa run`, so the only two
 * terminal states that reach the hub are "passed" and "failed".
 */
export const RunStatusSchema = z.enum(["passed", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * A pushed run. All fields are derived server-side from the report the client
 * pushed (`POST /runs`) — the run is immutable once created.
 */
export const RunSchema = z.object({
  id: z.string(),
  project: z.string(),
  /**
   * Which profile the run executed against (the env-var set / target
   * environment, e.g. "stg"). Runs are NOT scoped by profile — the list shows
   * every run of a project regardless — this only records which environment a
   * run used, so the UI can show it. Null for runs pushed before this existed.
   */
  profile: z.string().nullable(),
  branch: z.string().nullable(),
  status: RunStatusSchema,
  /** Spec-level counts derived from the report's `results[]`. */
  specs: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
  gitHead: z.string().nullable(),
  /** Analysis prompt version, carried through for cross-run triage comparison. */
  promptVersion: z.string(),
  /** The CI run id from the report (e.g. GITHUB_RUN_ID); null when run locally. */
  ciRunId: z.string().nullable(),
  /** When the report was produced (the actual test run time). */
  reportCreatedAt: z.string(),
  /** When the hub accepted the push (list ordering key). */
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * One failing spec's triage: the AI's prediction (read-only, sourced from
 * the run's report) paired with the human-recorded actual cause (write-only
 * from the client's perspective — the API is how it gets in).
 */
export const TriageCaseSchema = z.object({
  feature: z.string(),
  spec: z.string(),
  predicted: z.object({
    label: PredictedLabelSchema,
    confidence: z.number(),
    subDiagnosis: z.string().optional(),
    headline: z.string(),
  }),
  /** null when no human has recorded the actual cause yet. */
  actual: z
    .object({
      cause: FailureLabelSchema,
      note: z.string().optional(),
      recordedAt: z.string(),
    })
    .nullable(),
});
export type TriageCase = z.infer<typeof TriageCaseSchema>;

export const RunTriageSchema = z.object({
  runId: z.string(),
  promptVersion: z.string(),
  cases: z.array(TriageCaseSchema),
  /** Count of cases with a non-null `actual` — drives the UI's progress readout. */
  recorded: z.number(),
  total: z.number(),
});
export type RunTriage = z.infer<typeof RunTriageSchema>;

export const PutActualCauseRequestSchema = z.object({
  cause: FailureLabelSchema,
  note: z.string().optional(),
});
export type PutActualCauseRequest = z.infer<typeof PutActualCauseRequestSchema>;

export const SecretMetaSchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
});
export type SecretMeta = z.infer<typeof SecretMetaSchema>;

export const VariableMetaSchema = SecretMetaSchema.extend({
  sensitive: z.boolean(),
  /**
   * The decrypted value. Omitted from plain listings for sensitive variables
   * (so `ccqa hub var ls` doesn't print secrets); populated for every variable
   * when the caller explicitly requests `?include=values` (used by `ccqa run`
   * to fetch profile variables).
   */
  value: z.string().optional(),
});
export type VariableMeta = z.infer<typeof VariableMetaSchema>;

export const PutVariableRequestSchema = z.object({
  value: z.string(),
  sensitive: z.boolean(),
});
export type PutVariableRequest = z.infer<typeof PutVariableRequestSchema>;

export const HubErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type HubError = z.infer<typeof HubErrorSchema>;

/**
 * A triage-learning job. Grading failing specs in the hub UI produces the
 * "actual cause" labels this reads; the job turns them into an improved
 * analysis custom prompt (the one compute the hub does — it runs Claude to write a
 * short calibration note). Persisted so the queue survives a restart and the
 * UI can poll status and show the before/after prompt.
 */
export const LearningJobStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type LearningJobStatus = z.infer<typeof LearningJobStatusSchema>;

export const LearningJobSchema = z.object({
  id: z.string(),
  project: z.string(),
  profile: z.string(),
  status: LearningJobStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** Surfaced in the UI when `status === "failed"` (e.g. no Claude auth on the hub, no graded cases). */
  error: z.string().nullable(),
  /** What the run scanned, filled in as the worker learns. */
  input: z.object({
    runLimit: z.number(),
    /** How many graded cases were found across the scanned runs (0 fails the job). */
    casesConsidered: z.number(),
  }),
  /** Present only on success: the new custom prompt's version plus the fully-rendered prompt before and after. */
  result: z
    .object({
      customPromptVersion: z.string(),
      /** The analysis prompt as it was before this job (base-only on the first-ever learn). */
      beforePrompt: z.string(),
      /** The analysis prompt after applying the newly-learned custom prompt. */
      afterPrompt: z.string(),
    })
    .nullable(),
});
export type LearningJob = z.infer<typeof LearningJobSchema>;

/** Body of `POST /projects/:project/learning-jobs`. */
export const CreateLearningJobRequestSchema = z.object({
  profile: z.string(),
  /** How many recent runs to scan for graded cases. Default 50. */
  runLimit: z.number().int().positive().max(1000).optional(),
});
export type CreateLearningJobRequest = z.infer<typeof CreateLearningJobRequestSchema>;
