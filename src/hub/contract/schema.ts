import { z } from "zod";
import { ActualCauseSchema, DriftLabelSchema, DriftSurfaceSchema, PredictedLabelSchema } from "../../report/schema.ts";

/**
 * The hub's public REST contract (docs/hub-api.md). These schemas are
 * consumed on both sides of the wire: the hub validates request/response
 * bodies against them, and `ccqa/hub-client` re-exports them so any HTTP
 * client — the ccqa CLI, an intranet web app, the hub's own bundled UI —
 * gets the same types.
 */

/**
 * A run's outcome. "running" is non-terminal/mutable — an opened run
 * (`POST /runs/open`) sits in this state while it's patched incrementally.
 * "passed"/"failed" are terminal/immutable: a pushed run (`POST /runs`)
 * starts there directly, and an opened run ends there once done.
 */
export const RunStatusSchema = z.enum(["passed", "failed", "running"]);
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
  /** "run" = ccqa run/live execution; "drift" = ccqa audit --report-to-hub. */
  kind: z.enum(["run", "drift"]).default("run"),
  /**
   * Drift result pushed via `ccqa audit --report-to-hub`; null for kind:"run". Counts
   * by label rather than by a derived severity — a label IS the finding, and
   * the sum of the three is deliberately not carried: it would always equal
   * the number of audited specs with a diagnosis, one diagnosis per spec.
   */
  drift: z
    .object({
      /** How many specs this run audited. */
      specs: z.number(),
      testDrift: z.number(),
      specChange: z.number(),
      unknown: z.number(),
    })
    .nullable()
    .default(null),
  /**
   * The same counts after human grading, present only when at least one row of
   * a drift run has been graded. Joined in when the run is read, never stored
   * on the run: a terminal run records what the audit said (ADR-0009), and a
   * grade is a separate, later claim about the same rows. Readers that want
   * the current best answer take this when it is there and `drift` otherwise;
   * keeping both is what lets the confusion matrix stay honest about what the
   * model predicted.
   */
  gradedDrift: z
    .object({
      specs: z.number(),
      testDrift: z.number(),
      specChange: z.number(),
      unknown: z.number(),
      /** Rows a human cleared: the audit reported drift, there was none. */
      noDrift: z.number(),
      /** How many of this run's rows carry a grade at all. */
      graded: z.number(),
    })
    .optional(),
  /** Spec-level counts derived from the report's `results[]`. */
  specs: z.object({ total: z.number(), passed: z.number(), failed: z.number() }),
  gitHead: z.string().nullable(),
  /** Analysis prompt version, carried through for cross-run triage comparison. */
  promptVersion: z.string(),
  /** The CI run id from the report (e.g. GITHUB_RUN_ID); null when run locally. */
  ciRunId: z.string().nullable(),
  /**
   * URL of the CI run (the GitHub Actions run page), so the UI can link the
   * `Actions #<id>` chip to it. Optional so runs stored before this field, and
   * runs pushed outside CI, stay valid.
   */
  runUrl: z.string().nullable().optional(),
  /** When the report was produced (the actual test run time). */
  reportCreatedAt: z.string(),
  /** When the hub accepted the push (list ordering key). */
  createdAt: z.string(),
  /**
   * The commit the target environment was running when this run executed —
   * the baseline "needs re-run" compares against (ADR-0010). Null when the
   * profile has no deploy log and the client didn't say. Absent on runs
   * stored before this field existed.
   */
  deployedSha: z.string().nullable().optional(),
  /** Where `deployedSha` came from: the hub's own deploy log, or the client asserting it. */
  deployedShaSource: z.enum(["hub-deploy-log", "client"]).nullable().optional(),
  /**
   * True when the deploy-log head moved between opening and finalizing this
   * run: the run straddled a deploy, so which commit it actually exercised is
   * not knowable. Re-run selection reports `unknown` rather than guessing.
   */
  deployedShaAmbiguous: z.boolean().optional(),
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
  /** Generation target of the graded row; lets the UI filter the matrix by target. Optional for pre-existing data. */
  target: z.string().optional(),
  predicted: z.object({
    label: PredictedLabelSchema,
    confidence: z.number(),
    subDiagnosis: z.string().optional(),
    headline: z.string(),
  }),
  /** null when no human has recorded the actual cause yet. */
  actual: z
    .object({
      cause: ActualCauseSchema,
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
  cause: ActualCauseSchema,
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
 * One spec's "last time it passed" record in the last-green ledger. The hub
 * updates the ledger whenever a `kind: "run"` run reaches a terminal state:
 * every spec that passed gets its entry advanced to that run's `gitHead`
 * (newest `at` wins, so out-of-order finalizes can't move a baseline
 * backwards). `ccqa run --on-fail-explain` reads it to diff each
 * failing spec against the commit where that spec was last green.
 */
export const LastGreenEntrySchema = z.object({
  /** Full head sha of the run in which this spec last passed. */
  gitHead: z.string(),
  runId: z.string(),
  /** The run's reportCreatedAt — the ordering key for ledger updates. */
  at: z.string(),
});
export type LastGreenEntry = z.infer<typeof LastGreenEntrySchema>;

/**
 * One spec's record of a single run, as stored in a ledger bucket. Identical
 * to `LastGreenEntry` plus the commit the environment was running at the time
 * — without it a bucket entry can be ordered in wall-clock time but not
 * *positioned* against the deploy log, which is the only ordering re-run
 * selection may use (ADR-0010).
 */
export const SpecLedgerEntrySchema = LastGreenEntrySchema.extend({
  /** The run's `deployedSha`; absent on entries written before ADR-0010. */
  deployedSha: z.string().nullable().optional(),
  /** The run's `deployedShaAmbiguous`, denormalized so a verdict needs no run lookup. */
  deployedShaAmbiguous: z.boolean().optional(),
});
export type SpecLedgerEntry = z.infer<typeof SpecLedgerEntrySchema>;

/**
 * The per-(project, profile, branch) spec ledger: three buckets over the same
 * "feature/spec" keys, all advanced by the same terminal-run trigger.
 *
 * - `green` — the spec's last pass. Served as `entries` by `GET /last-green`.
 * - `run` — the spec's last *execution* of any non-skipped result. This, not
 *   `green`, is the baseline for "needs re-run": a red spec's information is
 *   already current, so re-running it teaches nothing until related code moves.
 * - `red` — the spec's last failure, so the view can show outcome and re-run
 *   need as the orthogonal axes they are.
 *
 * A skipped row did not execute and advances no bucket.
 */
export const SpecLedgerSchema = z.object({
  green: z.record(z.string(), SpecLedgerEntrySchema).default({}),
  run: z.record(z.string(), SpecLedgerEntrySchema).default({}),
  red: z.record(z.string(), SpecLedgerEntrySchema).default({}),
});
export type SpecLedger = z.infer<typeof SpecLedgerSchema>;

/** One deploy, as the consumer's deploy job reported it (ADR-0010). */
export const DeployEntrySchema = z.object({
  /** Monotonic position in the profile's log — the only ordering re-run selection compares. */
  index: z.number().int().nonnegative(),
  sha: z.string(),
  /** The commit this deploy replaced; null when the job didn't say. */
  previousSha: z.string().nullable(),
  at: z.string(),
  /** The ref that was deployed (e.g. a branch or tag), for display only. */
  ref: z.string().optional(),
  /** URL of the deploy job, so the view can link back to it. */
  runUrl: z.string().optional(),
  /**
   * Paths this deploy changed, from a two-dot diff. Record-only: shown by the
   * view, but not read by `verdict()` — which specs this deploy affects is
   * decided entirely from `hasSelection` and the folded touch index (see
   * `foldTouchIndex`/`computeRerun`). Null means the job didn't report them.
   */
  changedPaths: z.array(z.string()).nullable(),
  /**
   * Whether the deploy job supplied a spec selection alongside the paths.
   *
   * Re-run verdicts are folded from selections, so a deploy recorded without
   * one is a hole in the range: the specs behind it cannot be cleared, only
   * reported `unknown`. Recorded per entry rather than inferred, because
   * "nothing was selected" and "no selection was run" mean opposite things.
   */
  hasSelection: z.boolean().default(false),
  /** True when `previousSha` did not chain onto the log head, so history is missing before this entry. */
  gapBefore: z.boolean().default(false),
});
export type DeployEntry = z.infer<typeof DeployEntrySchema>;

/**
 * Whether a spec is reached by a change, as `ccqa select-specs` decides it.
 * The one source for this three-way union — `select/types.ts`'s CLI-internal
 * `SelectVerdict` re-exports this rather than declaring its own, since it's
 * the same value the CLI serializes into `DeploySelectionEntry` below.
 *
 * `unknown` is carried rather than collapsed into either answer. It is the
 * selector saying it could not tell, which must reach the view as its own
 * state — folding it into `notNeeded` would turn "we don't know" into "you're
 * covered".
 */
export const SelectVerdictSchema = z.enum(["needed", "notNeeded", "unknown"]);
export type SelectVerdict = z.infer<typeof SelectVerdictSchema>;

/**
 * One spec's verdict for one deploy, as `ccqa select-specs` decided it.
 *
 * The hub does not compute this and cannot: deciding which specs a change
 * reaches means reading the diff against what each spec actually does, and the
 * hub has no checkout. So the deploy job decides and reports, exactly as it
 * already does for `changedPaths` (ADR-0010).
 */
export const DeploySelectionEntrySchema = z.object({
  verdict: SelectVerdictSchema,
  reason: z.string(),
  /** Changed paths the selector tied to this spec. Present for `needed`. */
  touchedBy: z.array(z.string()).optional(),
});
export type DeploySelectionEntry = z.infer<typeof DeploySelectionEntrySchema>;

/** A deploy's selection, keyed by `"feature/spec"`. */
export const DeploySelectionSchema = z.record(z.string(), DeploySelectionEntrySchema);
export type DeploySelection = z.infer<typeof DeploySelectionSchema>;

/**
 * A profile's retained deploy log. `nextIndex` is kept separately from
 * `entries` because the ring buffer drops old entries: positions must keep
 * increasing across an eviction or a stored baseline would silently re-match
 * a different deploy.
 */
export const DeployLogSchema = z.object({
  nextIndex: z.number().int().nonnegative().default(0),
  entries: z.array(DeployEntrySchema).default([]),
});
export type DeployLog = z.infer<typeof DeployLogSchema>;

/** A deploy as reported, before the log assigns its position and applies its bounds. */
export type DeployInput = Omit<DeployEntry, "index" | "gapBefore">;

/**
 * One spec's entry in the touch index: the newest deploy that needed it, and
 * the newest that could not be decided, folded in as each deploy is recorded.
 *
 * This is the whole re-run computation, not an accelerator for it. Each spec's
 * baseline sits at a different position in the log, so the question is always
 * "since *this* spec last ran, was it ever needed" — two integer comparisons
 * against the positions kept here. Re-deriving it per read is impossible
 * anyway: the selections were made by a model against each deploy's diff, and
 * neither the diff nor the model is available at read time.
 *
 * Each fold reflects what the specs looked like when that deploy landed. A
 * spec edited afterwards is not retroactively re-judged — its own change marks
 * it needed at the next deploy, which is the honest place to notice it.
 */
export const SpecTouchSchema = z.object({
  /**
   * The newest deploy that needed this spec. Absent when no recorded selection
   * has ever needed it — which is what lets a baseline read as clean.
   */
  needed: z
    .object({
      /** A `DeployEntry.index`, comparable against a baseline's position across an eviction. */
      index: z.number().int().nonnegative(),
      /**
       * The deploy as the fold read it. The verdict is decided on `index`
       * alone, and what the view *names* is read back out of the log entry at
       * that index — so a deploy is never shown out of this derived copy when
       * the log no longer backs it.
       */
      sha: z.string(),
      at: z.string(),
      /** A bounded sample (`MAX_TOUCHED_BY`) of the paths the selector cited. */
      matchedPaths: z.array(z.string()),
    })
    .optional(),
  /**
   * Position of the newest deploy whose selection answered `unknown` here.
   * Kept apart from `needed` so an undecided deploy cannot read as a clean
   * one: a baseline behind it reports `unknown`, never `notNeeded`.
   */
  undecidedIndex: z.number().int().nonnegative().optional(),
});
export type SpecTouch = z.infer<typeof SpecTouchSchema>;

/** The derived touch index for one profile: "feature/spec" → its newest known touch. */
export const SpecTouchIndexSchema = z.record(z.string(), SpecTouchSchema);
export type SpecTouchIndex = z.infer<typeof SpecTouchIndexSchema>;

/**
 * Whether a spec's last result is still trustworthy. Deliberately named for
 * the action rather than for a freshness adjective: "needs re-run" (mechanical,
 * no model call) is a different question from drift (does the spec still
 * describe the product), and the two must not be conflated — see ADR-0010.
 */
export const RerunStateSchema = z.enum(["needed", "notNeeded", "blocked", "unknown", "neverRun", "notEvaluated"]);
export type RerunState = z.infer<typeof RerunStateSchema>;

/**
 * Why a spec is `blocked`. Always carried: the two answers differ in who
 * repairs them and how long that takes — a stale recording is re-recorded
 * automatically within minutes, a changed spec waits for a human — so a view
 * that showed only "blocked" would hide the distinction that matters most.
 */
export const RerunBlockedReasonSchema = z.enum([
  /** The audit found the generated test code stale. `ccqa record` repairs it. */
  "testDrift",
  /** The audit found the spec itself describes something the code no longer does. A human repairs it. */
  "specChange",
]);
export type RerunBlockedReason = z.infer<typeof RerunBlockedReasonSchema>;

/**
 * Why a spec is `unknown`. Always carried, so the view can name the missing
 * input ("no deploy log for this profile") instead of shrugging. `unknown` is
 * never rendered as "not needed".
 */
export const RerunUnknownReasonSchema = z.enum([
  /** A deploy in range was recorded without a spec selection, so its effect on this spec is unrecorded. */
  "noSelectionInRange",
  /** A selection in range answered `unknown` for this spec — the selector could not tell. */
  "selectionUnknown",
  /** Nothing has ever been recorded in this profile's deploy log. */
  "noDeployLog",
  /** The spec's last run predates deploy-sha stamping, or ran with no deploy log. */
  "unknownDeployedSha",
  /** The last run straddled a deploy, so which commit it exercised is not knowable. */
  "ambiguousDeployedSha",
  /** The last run's deployed sha is older than the retained log, so its position is lost. */
  "deployedShaNotInLog",
  /** A deploy in range did not chain onto its predecessor, so deploys are missing from the range. */
  "gapInRange",
]);
export type RerunUnknownReason = z.infer<typeof RerunUnknownReasonSchema>;

/** Where a deploy sits in a profile's log, as the view names it. */
export const DeployRefSchema = z.object({
  index: z.number().int().nonnegative(),
  sha: z.string(),
  at: z.string(),
});
export type DeployRef = z.infer<typeof DeployRefSchema>;

/**
 * One spec's re-run verdict plus the three ledger coordinates the view shows
 * alongside it. The coordinates are always present (null when the spec has no
 * such entry); `reason`, `touchedBy` and `touchedByDeploy` appear only in the
 * states named below.
 */
export const SpecRerunSchema = z.object({
  state: RerunStateSchema,
  /** Set only when `state === "unknown"`. */
  reason: RerunUnknownReasonSchema.optional(),
  /** Set only when `state === "blocked"`. */
  blockedReason: RerunBlockedReasonSchema.optional(),
  lastRun: SpecLedgerEntrySchema.nullable(),
  lastGreen: SpecLedgerEntrySchema.nullable(),
  lastRed: SpecLedgerEntrySchema.nullable(),
  /** A bounded sample (`MAX_TOUCHED_BY`) of the deployed paths that matched. Set only when `state === "needed"`. */
  touchedBy: z.array(z.string()).optional(),
  /**
   * The deploy that made this spec `needed`: the newest entry *within the
   * verdict's range* whose changes matched it. Distinct from the report's
   * `deployHead`, which is only the point the judgement was made at.
   *
   * ADDITIVE and optional, so a report from an older hub — and a client older
   * than this field — is unaffected. Null when the entry that proves the touch
   * is no longer retained in the log: the verdict still stands on the touch
   * index's position, but the deploy cannot be named without overstating.
   */
  touchedByDeploy: DeployRefSchema.nullable().optional(),
});
export type SpecRerun = z.infer<typeof SpecRerunSchema>;

/** Body of `GET /projects/:project/rerun?profile=`: one verdict per spec in the perspectives document. */
export const RerunReportSchema = z.object({
  project: z.string(),
  profile: z.string(),
  /** The profile's newest deploy, or null when nothing has been recorded. */
  deployHead: DeployRefSchema.nullable(),
  specs: z.record(z.string(), SpecRerunSchema),
});
export type RerunReport = z.infer<typeof RerunReportSchema>;

/** Body of `POST /projects/:project/deploys?profile=` — what the deploy job shipped. */
export const RecordDeployRequestSchema = z.object({
  sha: z.string().min(1),
  /**
   * The commit being replaced. Supply it: without it the hub cannot verify the
   * log is contiguous and records a gap, which makes affected specs `unknown`.
   */
  previousSha: z.string().min(1).nullable().optional(),
  /**
   * Changed paths from a **two-dot** diff (`git diff --name-only A B`). A
   * three-dot diff resolves the merge base and reports nothing on a rollback,
   * which would make the rollback invisible. Record-only — shown by the
   * view, but re-run verdicts are decided from `selection`/`hasSelection`,
   * not from these paths. Omit if it can't be produced.
   */
  changedPaths: z.array(z.string()).nullable().optional(),
  /**
   * Which specs this deploy reaches, from `ccqa select-specs`. Omit it and the
   * deploy becomes a hole in the range: specs behind it report `unknown`
   * rather than `notNeeded`, because nothing recorded what it touched.
   */
  selection: DeploySelectionSchema.optional(),
  ref: z.string().optional(),
  runUrl: z.string().optional(),
});
export type RecordDeployRequest = z.infer<typeof RecordDeployRequestSchema>;

/** Body of `GET /projects/:project/deploys?profile=` — newest last, as stored. */
export const DeployLogResponseSchema = z.object({
  entries: z.array(DeployEntrySchema),
  nextIndex: z.number().int().nonnegative(),
});
export type DeployLogResponse = z.infer<typeof DeployLogResponseSchema>;

/**
 * Body of `GET /projects/:project/last-green`. `entries` keeps its original
 * meaning — the green bucket — because older CLIs read it as such; the other
 * two buckets are siblings.
 */
export const LedgerResponseSchema = z.object({
  entries: z.record(z.string(), SpecLedgerEntrySchema),
  lastRun: z.record(z.string(), SpecLedgerEntrySchema).default({}),
  lastRed: z.record(z.string(), SpecLedgerEntrySchema).default({}),
});
export type LedgerResponse = z.infer<typeof LedgerResponseSchema>;

/**
 * One spec's last drift audit, as recorded by `ccqa audit --report-to-hub`. Unlike the
 * spec ledger above, this carries no profile: drift asks whether a spec still
 * describes the code, which has nothing to do with which environment is
 * running it (ADR-0010 draws the same line for "needs re-run").
 *
 * `label: null` is a completed audit that found no drift — a spec with no
 * entry at all in the ledger was simply never audited. The two must not be
 * conflated: `null` is an answer, a missing key is the absence of one.
 */
export const SpecDriftEntrySchema = z.object({
  label: DriftLabelSchema.nullable(),
  /** Set only when `label` is non-null — no surface applies to a clean audit. */
  surface: DriftSurfaceSchema.optional(),
  confidence: z.number().optional(),
  headline: z.string().optional(),
  /** The commit this audit read. */
  gitHead: z.string(),
  /** The `kind: "drift"` run this entry came from. */
  runId: z.string(),
  /** The run's reportCreatedAt — the ordering key for ledger updates. */
  at: z.string(),
  /**
   * Set once a human has graded this row: `label` is then their answer, not
   * the audit's. Kept as a flag rather than replacing the entry silently, so
   * a reader can tell a verdict that was confirmed from one that was merely
   * produced. A later audit of the same spec supersedes it, grade and all —
   * the newer observation is about newer code.
   */
  graded: z.boolean().optional(),
});
export type SpecDriftEntry = z.infer<typeof SpecDriftEntrySchema>;

/** The per-(project, branch) drift ledger: "feature/spec" → its last audit. */
export const DriftLedgerSchema = z.object({
  specs: z.record(z.string(), SpecDriftEntrySchema).default({}),
});
export type DriftLedger = z.infer<typeof DriftLedgerSchema>;

/**
 * Body of `GET /projects/:project/drift`. No `?profile=` — see `SpecDriftEntrySchema`.
 */
export const DriftLedgerResponseSchema = z.object({
  project: z.string(),
  specs: z.record(z.string(), SpecDriftEntrySchema),
});
export type DriftLedgerResponse = z.infer<typeof DriftLedgerResponseSchema>;

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
