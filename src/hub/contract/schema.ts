import { z } from "zod";
import {
  ActualCauseSchema,
  DriftLabelSchema,
  DriftSubDiagnosisSchema,
  DriftSurfaceSchema,
  PredictedLabelSchema,
  ReportKindSchema,
  SpecChangeKindSchema,
} from "../../report/schema.ts";

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
  /**
   * Which command left the run: "run" = ccqa run/live execution; "drift" =
   * ccqa audit --report-to-hub; "record" = ccqa record --report-to-hub.
   *
   * A recording produces no verdict about anything, so it exists here only to
   * put its Claude spend where a budget can see it — every ledger and every
   * count that answers "is this spec green" leaves it alone (ADR-0017).
   */
  kind: ReportKindSchema.default("run"),
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
  /**
   * The run's total Claude spend, copied from the pushed report's
   * `cost.totalCostUsd` — derived server-side like every other field here, so a
   * client cannot assert its own number. Refreshed on every incremental PATCH
   * rather than written once, so a run killed mid-flight still says what it
   * burned.
   *
   * Null when the run billed nothing (a deterministic run that passed calls
   * Claude at no point), and absent on runs stored before this field existed.
   * Optional rather than defaulted for that second case: run records are read
   * back as stored and never re-parsed, so a default would erase the marker
   * from the type without ever running, leaving `undefined` where a reader was
   * promised a number.
   */
  costUsd: z.number().nullable().optional(),
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
   * not knowable. Re-run selection treats the result as `stale` rather than
   * crediting it with either commit.
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
      /**
       * True when `cause` is not one of the causes this row's kind accepts
       * (e.g. `NO_DRIFT` on `kind: "run"`). Excluded from the confusion
       * matrix and learning input; nothing converts it — regrade instead.
       */
      invalidForKind: z.boolean().optional(),
    })
    .nullable(),
});
export type TriageCase = z.infer<typeof TriageCaseSchema>;

export const RunTriageSchema = z.object({
  runId: z.string(),
  promptVersion: z.string(),
  cases: z.array(TriageCaseSchema),
  /** Count of cases with a non-null `actual` that is valid for this row's kind. Excludes `recordedInvalidForKind`. */
  recorded: z.number(),
  /** Of the graded cases, how many carry `invalidForKind: true` — excluded from `recorded`, the confusion matrix, and learning. */
  recordedInvalidForKind: z.number(),
  total: z.number(),
});
export type RunTriage = z.infer<typeof RunTriageSchema>;

export const PutActualCauseRequestSchema = z.object({
  cause: ActualCauseSchema,
  note: z.string().optional(),
});
export type PutActualCauseRequest = z.infer<typeof PutActualCauseRequestSchema>;

/** One entry `PUT /runs/:id/triage/actual-causes` could not import, and why. */
export const ImportActualCauseRejectionSchema = z.object({
  feature: z.string(),
  spec: z.string(),
  reason: z.string(),
});
export type ImportActualCauseRejection = z.infer<typeof ImportActualCauseRejectionSchema>;

/** Response of `PUT /runs/:id/triage/actual-causes`. */
export const ImportActualCausesResponseSchema = z.object({
  imported: z.number(),
  /** Entries skipped — no matching row, or a cause invalid for this row's kind — so a caller can tell nothing silently vanished. */
  rejected: z.array(ImportActualCauseRejectionSchema),
});
export type ImportActualCausesResponse = z.infer<typeof ImportActualCausesResponseSchema>;

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
 * *positioned* against the deploy log, which is the only ordering the
 * staleness verdict may use (ADR-0010). Wall-clock order is fit only for
 * scheduling within an already-decided set, where a mis-ranking delays a
 * spec rather than excusing it.
 */
export const SpecLedgerEntrySchema = LastGreenEntrySchema.extend({
  /** The run's `deployedSha`; absent on entries written before ADR-0010. */
  deployedSha: z.string().nullable().optional(),
  /** The run's `deployedShaAmbiguous`, denormalized so a verdict needs no run lookup. */
  deployedShaAmbiguous: z.boolean().optional(),
});
export type SpecLedgerEntry = z.infer<typeof SpecLedgerEntrySchema>;

/**
 * A red-bucket entry: where the failure happened, plus what it was. The cause
 * is copied off the run report's `analysis` so a reader learns why a spec is
 * red without fetching the report of every red spec.
 *
 * Only the red bucket carries it. A pass has no cause, so putting these on
 * `SpecLedgerEntry` would invite writing them where they cannot exist.
 *
 * Both fields are optional and mean the same thing by their absence — nothing
 * is on record. Failure analysis is opt-in (`--on-fail-explain`), and entries
 * written before this release have neither field.
 */
export const SpecRedLedgerEntrySchema = SpecLedgerEntrySchema.extend({
  /** The failure analysis' verdict. */
  label: PredictedLabelSchema.optional(),
  /** Its single-sentence conclusion, as shown at the top of the report's diagnosis. */
  headline: z.string().optional(),
});
export type SpecRedLedgerEntry = z.infer<typeof SpecRedLedgerEntrySchema>;

/**
 * The per-(project, profile, branch) spec ledger: three buckets over the same
 * "feature/spec" keys, all advanced by the same terminal-run trigger.
 *
 * - `green` — the spec's last pass. Served as `entries` by `GET /last-green`.
 * - `run` — the spec's last *execution* of any non-skipped result. This, not
 *   `green`, is the baseline for "needs re-run": a red spec's information is
 *   already current, so re-running it teaches nothing until related code moves.
 * - `red` — the spec's last failure, so the view can show outcome and re-run
 *   need as the orthogonal axes they are. Alone among the three it also carries
 *   the cause (`SpecRedLedgerEntry`).
 *
 * A skipped row did not execute and advances no bucket.
 */
export const SpecLedgerSchema = z.object({
  green: z.record(z.string(), SpecLedgerEntrySchema).default({}),
  run: z.record(z.string(), SpecLedgerEntrySchema).default({}),
  red: z.record(z.string(), SpecRedLedgerEntrySchema).default({}),
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
 * "since *this* spec last ran, was it ever needed" — one integer comparison
 * against the `needed` position kept here. Re-deriving it per read is impossible
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
   * Record-only since ADR-0023: freshness reads an undecided judgment as
   * "did not reach", so this position moves no verdict. Nothing reads it
   * back today; it stays recorded so what the selector answered is not
   * lost, and so reverting ADR-0023 would not need a data migration.
   */
  undecidedIndex: z.number().int().nonnegative().optional(),
});
export type SpecTouch = z.infer<typeof SpecTouchSchema>;

/** The derived touch index for one profile: "feature/spec" → its newest known touch. */
export const SpecTouchIndexSchema = z.record(z.string(), SpecTouchSchema);
export type SpecTouchIndex = z.infer<typeof SpecTouchIndexSchema>;

/**
 * Axis 1: what the audit says about this spec *relative to what is deployed
 * now*. An audit that read an older commit says nothing about the one running
 * today, which is why staleness is a state here rather than a footnote.
 */
export const AuditStateSchema = z.enum([
  /**
   * The audit owes an answer for the deployed commit: never audited, audited
   * at an older one, or audited at a commit the deploy log cannot place —
   * unplaceable is treated as reached (ADR-0014), and
   * `auditAssumedReached` names which hole. Not "an audit is running" — work
   * in flight is a lock, which has a lifetime the axes do not.
   */
  "due",
  /** The spec still describes the deployed code. */
  "clean",
  /** The audit found drift. `driftLabel` names which kind. */
  "drifted",
  /** The audit read the code and could not decide. */
  "undecided",
]);
export type AuditState = z.infer<typeof AuditStateSchema>;

/**
 * Axis 2: what happened the last time this spec ran, and whether that result
 * still covers what is deployed.
 */
export const ExecutionStateSchema = z.enum([
  /** The last run passed, against the commit deployed now. */
  "passed",
  /**
   * The last run failed, and nobody has answered that failure. Stated whatever
   * has deployed since: a red result is current information until a person
   * speaks to it (ADR-0020).
   */
  "failed",
  /**
   * The last run finished, but a deploy has reached this spec since — or the
   * log cannot place the run, which is treated the same way and named by
   * `executionAssumedReached`, or a person's lapsed attestation already
   * answered the red, which carries no annotation because the deploy log was
   * never consulted. The result is kept; only its currency is void.
   */
  "stale",
  /**
   * No run at all. Kept apart from `stale` even though both lead to
   * `rerunNeeded`: merging them loses the difference between a spec added
   * yesterday and one a deploy invalidated.
   */
  "neverRun",
]);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

/**
 * The one answer derived from the two axes above, listed in the order they are
 * evaluated. Named for who acts next, because that is what a reader scanning a
 * list of specs is looking for: exactly one value, `needsRepair`, asks for a
 * person.
 */
export const SpecVerdictSchema = z.enum([
  /** An audit or a run is in flight, or the audit has not caught up with the deploy. Wait. */
  "inProgress",
  /** A person must repair something: drift, an audit that could not decide, or a failed run. */
  "needsRepair",
  /** Cleared by the audit, and the last result does not cover what is deployed. */
  "rerunNeeded",
  /** Cleared by the audit, and the last run passed against what is deployed. */
  "verified",
  /**
   * A person checked the behaviour by hand and their attestation still covers
   * what is deployed. Overrides what the axes would have said — they are
   * shipped unchanged beside it — and lapses on its own when a deploy reaches
   * the spec or the spec itself is edited (`manual` names the attestation).
   * Kept apart from `verified`: one is the machine's answer, one is a
   * person's word.
   */
  "manuallyVerified",
]);
export type SpecVerdict = z.infer<typeof SpecVerdictSchema>;

/**
 * Which hole in the deploy log made the hub assume a deploy reached this spec
 * (ADR-0014). Not a state: the verdict is already decided by the time one of
 * these is attached, and it exists so the view can say *why* a spec is pending
 * instead of leaving the reader to guess.
 */
export const RerunUnknownReasonSchema = z.enum([
  /** A deploy in range was recorded without a spec selection, so its effect on this spec is unrecorded. */
  "noSelectionInRange",
  /**
   * A selection in range answered `unknown` for this spec. Not produced
   * since ADR-0023 — an undecided judgment counts as not reached — but a
   * client can still read it from an older hub.
   */
  "selectionUnknown",
  /** Nothing has ever been recorded in this profile's deploy log. */
  "noDeployLog",
  /** The spec's last run predates deploy-sha stamping, or ran with no deploy log. */
  "unknownDeployedSha",
  /** The last run straddled a deploy, so which commit it exercised is not knowable. */
  "ambiguousDeployedSha",
  /**
   * The last run's deployed sha does not appear in the retained log. Usually
   * a deploy that was never recorded, or a sha asserted from a different
   * profile's log; the log's own bounded retention can also evict it, but
   * that is the rarer case.
   */
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
 * A job holding a spec so a second one does not start on it.
 *
 * Not a value on either axis. The axes are derived from durable ledgers and
 * describe recorded facts; a lock describes work in flight, which needs a
 * lifetime the axes have no reason to carry. It also spans both jobs — one
 * mechanism rather than a parallel value in each enum.
 */
export const SpecLockSchema = z.object({
  kind: z.enum(["audit", "run"]),
  /** Opaque id of the job holding it. Only that job may release it. */
  holder: z.string(),
  /**
   * When the hold lapses. Evaluated on read, so a job that died without
   * releasing clears itself with no reaper — at the cost of holding its specs
   * until this passes. This is the one place wall-clock time is used; ordering
   * against deploys still goes by log position (ADR-0010).
   */
  expiresAt: z.string(),
});
export type SpecLock = z.infer<typeof SpecLockSchema>;

/**
 * The per-(project, profile) lock document: key → who holds it. A key is a
 * spec ("feature/spec") or a shared resource ("resource:<name>", ADR-0015);
 * the separators keep the two apart.
 */
export const SpecLocksSchema = z.object({
  specs: z.record(z.string(), SpecLockSchema).default({}),
});
export type SpecLocks = z.infer<typeof SpecLocksSchema>;

/** Body of `POST /projects/:project/locks?profile=`. */
export const AcquireLocksRequestSchema = z.object({
  specs: z.array(z.string()).min(1),
  kind: z.enum(["audit", "run"]),
  holder: z.string().min(1),
  ttlSeconds: z.number().int().positive(),
});
export type AcquireLocksRequest = z.infer<typeof AcquireLocksRequestSchema>;

/**
 * Which specs the caller may work on. `denied` is not an error: another job got
 * there first, and skipping those is the whole point.
 */
export const AcquireLocksResponseSchema = z.object({
  granted: z.array(z.string()),
  denied: z.array(z.string()),
});
export type AcquireLocksResponse = z.infer<typeof AcquireLocksResponseSchema>;

/** Body of `DELETE /projects/:project/locks?profile=`. */
export const ReleaseLocksRequestSchema = z.object({
  holder: z.string().min(1),
});
export type ReleaseLocksRequest = z.infer<typeof ReleaseLocksRequestSchema>;

/**
 * A person's word that they checked a spec's behaviour by hand against the
 * deployed environment. It overrides the verdict, never the ledgers: the
 * drift entry that parked the spec stays open, so the repair loop keeps its
 * reason to fix the test, while the verdict stops asking a person for what a
 * person already did.
 *
 * Anchored to the deploy head at the moment it was recorded, so it lapses on
 * its own — a deploy reaching the spec, or the spec being edited, ends its
 * coverage the same way those end a run's (ADR-0010). One per spec: a new
 * attestation replaces the previous one.
 */
export const AttestationSchema = z.object({
  /** Who checked. Free text — the hub has no accounts to resolve it against. */
  by: z.string().min(1),
  /** When the hub recorded it (stamped server-side). */
  at: z.string(),
  note: z.string().optional(),
  /**
   * The profile's deploy head when recorded, or null when the profile had no
   * deploy log yet. The anchor freshness is judged against.
   */
  deployedSha: z.string().nullable(),
});
export type Attestation = z.infer<typeof AttestationSchema>;

/** The per-(project, profile) attestation document: "feature/spec" → the standing attestation. */
export const AttestationsSchema = z.object({
  specs: z.record(z.string(), AttestationSchema).default({}),
});
export type Attestations = z.infer<typeof AttestationsSchema>;

/**
 * Why an attestation stopped covering the spec. One reason is named even when
 * several hold, in the order the checks run (coverage, then the spec's own
 * edits, then a later red run) — enough for a reader to see what to verify
 * before attesting again.
 */
export const AttestationLapseSchema = z.enum([
  /** A deploy reached the spec after the person checked. `manualLapsedByDeploy` names it when the log can. */
  "deployReached",
  /** The log cannot place the attestation's sha — assumed reached rather than trusted (ADR-0014). */
  "cannotPlace",
  /** The spec's text was edited after the person checked, so what they checked is not what is here now. */
  "specEdited",
  /** A run failed after the person checked — newer information than their word. */
  "newerRed",
]);
export type AttestationLapse = z.infer<typeof AttestationLapseSchema>;

/** Body of `PUT /projects/:project/attestations?profile=`. */
export const PutAttestationRequestSchema = z.object({
  /** "feature/spec" */
  spec: z.string().min(1).max(512),
  by: z.string().min(1).max(256),
  note: z.string().max(4000).optional(),
});
export type PutAttestationRequest = z.infer<typeof PutAttestationRequestSchema>;

/** Body of `DELETE /projects/:project/attestations?profile=`. */
export const DeleteAttestationRequestSchema = z.object({
  /** "feature/spec" */
  spec: z.string().min(1).max(512),
});
export type DeleteAttestationRequest = z.infer<typeof DeleteAttestationRequestSchema>;

/** Answer of PUT (the attestation as stamped) and GET (the whole document). */
export const AttestationResponseSchema = z.object({
  project: z.string(),
  profile: z.string(),
  spec: z.string(),
  attestation: AttestationSchema,
});
export type AttestationResponse = z.infer<typeof AttestationResponseSchema>;

export const AttestationsResponseSchema = z.object({
  project: z.string(),
  profile: z.string(),
  specs: z.record(z.string(), AttestationSchema),
});
export type AttestationsResponse = z.infer<typeof AttestationsResponseSchema>;

/**
 * A person's answer to one audit finding: the spec describes the code fine,
 * and the finding is wrong. Where an attestation speaks about the product,
 * this speaks about the *audit* — so it settles the audit axis rather than
 * the verdict, and the spec goes back to being run like any other.
 *
 * Pinned to the audit run whose finding it answers. A later audit is a new
 * observation of newer code, so it produces a new run and this stops
 * applying: the machine gets to raise the finding again, and the record of
 * the last dismissal is shown beside it rather than silently suppressing it.
 * No profile — an audit finding is about the repository, not an environment
 * (ADR-0013), which is also why this is scoped per project alone.
 */
export const AuditDismissalSchema = z.object({
  /** Who judged the finding wrong. Free text — the hub has no accounts. */
  by: z.string().min(1),
  /** When the hub recorded it (stamped server-side). */
  at: z.string(),
  /** Why. Required: this is the correction a mis-firing audit learns from. */
  note: z.string().min(1),
  /** The `kind: "drift"` run whose finding this answers. */
  auditRunId: z.string(),
  /** What was dismissed, copied so a reader needs only this record. */
  label: DriftLabelSchema,
  headline: z.string(),
});
export type AuditDismissal = z.infer<typeof AuditDismissalSchema>;

/** The per-project dismissal document: "feature/spec" → the last dismissal. */
export const AuditDismissalsSchema = z.object({
  specs: z.record(z.string(), AuditDismissalSchema).default({}),
});
export type AuditDismissals = z.infer<typeof AuditDismissalsSchema>;

/** Body of `PUT /projects/:project/audit-dismissals`. */
export const PutAuditDismissalRequestSchema = z.object({
  /** "feature/spec" */
  spec: z.string().min(1).max(512),
  by: z.string().min(1).max(256),
  note: z.string().min(1).max(4000),
});
export type PutAuditDismissalRequest = z.infer<typeof PutAuditDismissalRequestSchema>;

/** Body of `DELETE /projects/:project/audit-dismissals`. */
export const DeleteAuditDismissalRequestSchema = z.object({
  /** "feature/spec" */
  spec: z.string().min(1).max(512),
});
export type DeleteAuditDismissalRequest = z.infer<typeof DeleteAuditDismissalRequestSchema>;

export const AuditDismissalResponseSchema = z.object({
  project: z.string(),
  spec: z.string(),
  dismissal: AuditDismissalSchema,
});
export type AuditDismissalResponse = z.infer<typeof AuditDismissalResponseSchema>;

export const AuditDismissalsResponseSchema = z.object({
  project: z.string(),
  specs: z.record(z.string(), AuditDismissalSchema),
});
export type AuditDismissalsResponse = z.infer<typeof AuditDismissalsResponseSchema>;

/**
 * One spec's verdict, the two axes it was derived from, and the three ledger
 * coordinates the view shows alongside them. The coordinates are always
 * present (null when the spec has no such entry); the optional fields appear
 * only in the states named below.
 *
 * Both axes ship alongside the verdict rather than being recomputed by
 * readers: the verdict answers "who acts next", and the axes answer "why",
 * which is the question every reader asks second.
 */
export const SpecRerunSchema = z.object({
  verdict: SpecVerdictSchema,
  audit: AuditStateSchema,
  execution: ExecutionStateSchema,
  /** Set only when `audit === "drifted"`. `UNKNOWN` belongs to `undecided`, so it cannot appear here. */
  driftLabel: DriftLabelSchema.exclude(["UNKNOWN"]).optional(),
  /**
   * Set when `audit === "due"` only because the log could not place the audit.
   * Absent when it is due for the ordinary reasons — never audited, or a
   * deploy demonstrably reached it.
   */
  auditAssumedReached: RerunUnknownReasonSchema.optional(),
  /**
   * The spec's last dismissal, whenever one exists — applied or not. Both are
   * worth showing: one that no longer applies means a later audit raised a
   * finding it does not answer for, and the reader should know this argument
   * has been had before. ADDITIVE and optional.
   */
  auditDismissed: AuditDismissalSchema.optional(),
  /**
   * Whether the dismissal above is what settled the audit axis. Stated rather
   * than inferred from `audit === "clean"`: a spec a later audit cleared on
   * its own reads `clean` too, and a reader must not credit that to the
   * person. Set exactly when `auditDismissed` is.
   */
  auditDismissalApplied: z.boolean().optional(),
  /**
   * Set when `execution === "stale"` only because the log could not place the
   * run. Absent when a deploy demonstrably reached the spec, which
   * `touchedBy`/`touchedByDeploy` name instead. Both fields can be set at
   * once: one hole can swallow both baselines.
   */
  executionAssumedReached: RerunUnknownReasonSchema.optional(),
  /**
   * Set when the spec itself has been edited since the audit read it, or since
   * the last run. A verdict is a claim about a (spec, product) pair, so either
   * side moving invalidates it — the deploy log only covers the product side.
   * Absent when the inventory carries no edit time (a document written by an
   * older CLI), which leaves the deploy-only comparison in place.
   */
  specChangedSince: z.string().optional(),
  /**
   * The spec's standing attestation, whenever one still covers what is
   * deployed. The verdict is `manuallyVerified` only when it also had
   * something to override — on a held or machine-verified spec the
   * attestation changed nothing, but it is still here so it can be seen and
   * revoked. ADDITIVE and optional, so a client older than this field is
   * unaffected — as are the fields below.
   */
  manual: AttestationSchema.optional(),
  /**
   * An attestation that exists but no longer covers what is deployed, kept
   * visible with the reason it lapsed instead of silently vanishing — the
   * person deciding whether to attest again needs to know what changed since
   * they last looked. The verdict is the axes' own answer again — with the red
   * they answered retired to `stale`, so the spec rejoins the cycle rather than
   * falling back onto it (ADR-0020). A lapse the newer red caused is the
   * exception: nobody has answered that one.
   */
  manualLapsed: AttestationSchema.extend({ because: AttestationLapseSchema }).optional(),
  /** The deploy that ended the attestation, when `manualLapsed.because === "deployReached"` and the log can name it. */
  manualLapsedByDeploy: DeployRefSchema.nullable().optional(),
  /**
   * Which hole made the attestation unplaceable, when `manualLapsed.because
   * === "cannotPlace"` — the same annotation the axes keep
   * (`auditAssumedReached` / `executionAssumedReached`), for the same reason:
   * the eight ways a log fails to answer call for different fixes (ADR-0014).
   */
  manualLapsedReason: RerunUnknownReasonSchema.optional(),
  /** The job working on this spec right now, or null. Expired holds read as null. */
  heldBy: SpecLockSchema.nullable(),
  lastRun: SpecLedgerEntrySchema.nullable(),
  lastGreen: SpecLedgerEntrySchema.nullable(),
  /** Carries the failure's `label`/`headline` when the run recorded an analysis. */
  lastRed: SpecRedLedgerEntrySchema.nullable(),
  /** A bounded sample (`MAX_TOUCHED_BY`) of the deployed paths that matched. Set only when `execution === "stale"`. */
  touchedBy: z.array(z.string()).optional(),
  /**
   * The deploy that made this spec `stale`: the newest entry *within the
   * run's range* whose changes matched it. Distinct from the report's
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

/**
 * Why this spec does or does not need auditing. Everything but `current` and
 * `held` audits. `held` is not an answer about freshness at all — another job
 * is on it, so this one skips it and asks again next cycle. `cannotTell`
 * survives here because it is a real explanation of why an audit is owed; the
 * re-run axis folds it into `due` (ADR-0014).
 */
export const AuditNeedSchema = z.object({
  because: z.enum(["neverAudited", "deployReached", "cannotTell", "held", "current"]),
  /** Set only when `because === "cannotTell"`. */
  reason: RerunUnknownReasonSchema.optional(),
});
export type AuditNeed = z.infer<typeof AuditNeedSchema>;

/** Body of `GET /projects/:project/audit-needed?profile=`: one answer per spec. */
export const AuditNeedReportSchema = z.object({
  project: z.string(),
  profile: z.string(),
  specs: z.record(z.string(), AuditNeedSchema),
});
export type AuditNeedReport = z.infer<typeof AuditNeedReportSchema>;

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
   * log is contiguous, so it records a gap and every spec behind it is treated
   * as reached — correct, but it costs a full sweep.
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
   * Which specs this deploy reaches, from `ccqa select-specs`. It narrows;
   * omitting it narrows nothing, so every spec behind the entry is treated as
   * reached. Safe, and the reason a missed selection costs a full sweep.
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
  lastRed: z.record(z.string(), SpecRedLedgerEntrySchema).default({}),
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
  /**
   * The diagnosis's finer-grained kind (e.g. selector drift vs over-assertion),
   * so a CI reader can branch on which repair a drifted spec needs. Optional:
   * absent on entries written before this field existed, and on clean audits.
   */
  subDiagnosis: DriftSubDiagnosisSchema.optional(),
  /** See `SpecChangeKindSchema`. */
  specChangeKind: SpecChangeKindSchema.optional(),
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
    /** How many graded cases fed the learning prompt. 0 always fails the job; `casesExcluded`, if any, explains why in the error message. */
    casesConsidered: z.number(),
    /** Of the scanned rows, how many were skipped because their recorded cause is not valid for that row's kind. Optional: absent on jobs recorded before this field existed. */
    casesExcluded: z.number().optional(),
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

// Bounds on an ack's key set. Both sit orders of magnitude above any plausible
// set of short keys, so they only ever stop a malformed client from writing an
// unbounded document.
const MAX_ACK_KEYS = 5000;
const MAX_ACK_KEY_LENGTH = 256;

/**
 * A named set of opaque keys a consumer has already acted on, as stored (see
 * `AckStore`). `at` is null only for a set that was never written — an ack
 * nobody has recorded yet reads as empty rather than missing.
 */
export const AckSchema = z.object({
  keys: z.array(z.string()),
  at: z.string().nullable(),
});
export type Ack = z.infer<typeof AckSchema>;

/** Body of `PUT /projects/:project/acks/:name?profile=` — the whole set, not a delta. */
export const PutAckRequestSchema = z.object({
  keys: z.array(z.string().min(1).max(MAX_ACK_KEY_LENGTH)).max(MAX_ACK_KEYS),
});
export type PutAckRequest = z.infer<typeof PutAckRequestSchema>;

/** Body of `GET`/`PUT /projects/:project/acks/:name?profile=`. */
export const AckResponseSchema = AckSchema.extend({
  project: z.string(),
  profile: z.string(),
  name: z.string(),
});
export type AckResponse = z.infer<typeof AckResponseSchema>;

/**
 * What one batch of ccqa invocations spent on Claude, as the job that ran them
 * reported it (see `SpendStore`). `label` is the consumer's name for the batch
 * — its job name — and the only thing that says where the money went.
 */
export const SpendEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  costUsd: z.number(),
  label: z.string(),
  /** The CI run that produced the batch, so a total can be traced back to its job. */
  ciRunId: z.string().optional(),
  runUrl: z.string().optional(),
});
export type SpendEntry = z.infer<typeof SpendEntrySchema>;

/**
 * A project's retained spend log, in arrival order — `at` is the reporting
 * job's, so a late push lands last whatever it says. Readers sort.
 */
export const SpendLogSchema = z.object({
  entries: z.array(SpendEntrySchema).default([]),
});
export type SpendLog = z.infer<typeof SpendLogSchema>;

/** Body of `POST /projects/:project/spend` — one batch's total. `at` defaults to now. */
export const RecordSpendRequestSchema = z.object({
  costUsd: z.number().nonnegative(),
  label: z.string().min(1).max(200),
  at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "at must be an ISO-8601 instant").optional(),
  ciRunId: z.string().optional(),
  runUrl: z.string().optional(),
});
export type RecordSpendRequest = z.infer<typeof RecordSpendRequestSchema>;

/**
 * Body of `GET /projects/:project/spend?since=&until=`, newest first. `since`
 * and `until` echo the window that was asked for (null for an open end), so a
 * reader of `totalUsd` can tell what it totals.
 */
export const SpendLogResponseSchema = z.object({
  project: z.string(),
  since: z.string().nullable(),
  until: z.string().nullable(),
  totalUsd: z.number(),
  entries: z.array(SpendEntrySchema),
});
export type SpendLogResponse = z.infer<typeof SpendLogResponseSchema>;
