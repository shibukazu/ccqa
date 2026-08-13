import { z } from "zod";
import { FIXABLE_DIAGNOSIS_TYPES } from "../diagnose/types.ts";

/**
 * One vocabulary, two answerable subsets.
 *
 * A failing test has one of four causes, and each names the artifact that has
 * to change:
 *  - TEST_DRIFT:  the generated test code. What the spec verifies is
 *                 unchanged; only the code that runs fell out of step (a
 *                 selector rename, a timing assumption, an over-tight
 *                 assertion).
 *  - SPEC_CHANGE: the spec. The thing being verified itself changed — a UI
 *                 redesign, a reworked flow. A human re-drafts it.
 *  - PRODUCT_BUG: the product. An error response, a missing side effect,
 *                 wrong data, a flow that no longer completes.
 *  - ENVIRONMENT: nothing in the repository. A service that is down, a
 *                 missing or expired credential, absent seeded data, timing.
 *
 * The audit answers the first two and no more: it never opens a browser, so
 * it has no standing to say the product is broken or the environment failed.
 * A run answers all four in one call — it holds the execution evidence and
 * reads the source itself, so the question is never split across stages.
 *
 * The stakeholder ask behind this module is measurement-first: the call is
 * known to be hard, so every prediction is carried in report.json where the
 * hub UI lets a human record the ground truth and computes the confusion
 * matrix client-side. Accuracy may start low; it must be *visible*.
 */
export const DRIFT_FAILURE_CAUSES = ["TEST_DRIFT", "SPEC_CHANGE"] as const;
export const FAILURE_CAUSES = [...DRIFT_FAILURE_CAUSES, "PRODUCT_BUG", "ENVIRONMENT"] as const;

/** What a model may answer: a cause, or UNKNOWN when the evidence is too weak. */
export const PREDICTED_LABELS = [...FAILURE_CAUSES, "UNKNOWN"] as const;
export const PredictedLabelSchema = z.enum(PREDICTED_LABELS);
export type PredictedLabel = z.infer<typeof PredictedLabelSchema>;

/**
 * What a human may record as the ground truth.
 *
 * The audit can be wrong in one way a run cannot: it can report drift on a
 * spec that still describes the product. `NO_DRIFT` records that, and it is
 * offered on audit rows only — "the test failed but nothing is wrong" is not
 * an answer about a run, where `ENVIRONMENT` says it instead.
 *
 * `UNKNOWN` is deliberately absent on both sides: a grade is the answer, and
 * "I don't know" is a reason not to grade rather than a grade.
 */
export const NO_DRIFT_CAUSE = "NO_DRIFT";
export const DRIFT_ACTUAL_CAUSES = [...DRIFT_FAILURE_CAUSES, NO_DRIFT_CAUSE] as const;
export const ACTUAL_CAUSES = [...FAILURE_CAUSES, NO_DRIFT_CAUSE] as const;
export const ActualCauseSchema = z.enum(ACTUAL_CAUSES);
export type ActualCause = z.infer<typeof ActualCauseSchema>;

/**
 * Report rows come in kinds, and each answers fewer questions than the last.
 * A "record" row answers none: it says a recording happened and what it cost,
 * and nothing was judged, so both vocabularies below are empty for it.
 *
 * The one source for the vocabulary: the report envelope, the hub's
 * `Run.kind` and the `?kind=` query params all derive from this enum, so a
 * fourth kind cannot be half-added. What a kind that judges nothing may and
 * may not advance is ADR-0017.
 */
export const ReportKindSchema = z.enum(["run", "drift", "record"]);
export type ReportKind = z.infer<typeof ReportKindSchema>;

/** What a person may record on a row of this kind. */
export function causesForKind(kind: ReportKind): readonly ActualCause[] {
  if (kind === "record") return [];
  return kind === "drift" ? DRIFT_ACTUAL_CAUSES : FAILURE_CAUSES;
}

/** What the model may answer on a row of this kind. */
export function predictedForKind(kind: ReportKind): readonly PredictedLabel[] {
  if (kind === "record") return [];
  return kind === "drift"
    ? ([...DRIFT_FAILURE_CAUSES, "UNKNOWN"] as const)
    : PREDICTED_LABELS;
}

export const SUB_DIAGNOSES = [...FIXABLE_DIAGNOSIS_TYPES, "NONE"] as const;

export const FailureEvidenceSchema = z.object({
  /** file:line or diff-hunk reference backing the claim. Optional for log-only evidence. */
  file: z.string().optional(),
  detail: z.string(),
});
export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;

/**
 * Which of a test case's two surfaces drifted, and therefore how it gets fixed.
 *
 * A `deterministic` spec is two artifacts: the spec.yaml a human wrote and the
 * test code `ccqa generate` produced from it. Either can fall out of step with
 * the source, and the repair differs — a stale spec has to be rewritten (and
 * the code regenerated after), while stale code only has to be regenerated.
 * A `mode: live` spec has no generated surface: the spec *is* the test, so this
 * is always `spec` there.
 *
 * When both surfaces are stale the spec is the root and this reads `spec`:
 * fixing it and regenerating settles the code too.
 *
 * Declared ahead of `FailureAnalysisSchema` (rather than beside
 * `DriftDiagnosisSchema` below, its other user) so both can reference it.
 */
export const DriftSurfaceSchema = z.enum(["spec", "generated"]);
export type DriftSurface = z.infer<typeof DriftSurfaceSchema>;

/**
 * Which repair a `SPEC_CHANGE` needs: `FEATURE_REMOVED` means the behaviour
 * the spec checks is gone from the code, so the spec goes with it;
 * `BEHAVIOUR_CHANGED` means it still exists but works differently, so the spec
 * is rewritten and re-recorded.
 *
 * A fourth axis rather than a `subDiagnosis` value, because that vocabulary is
 * `[...FIXABLE_DIAGNOSIS_TYPES, "NONE"]` — the shapes a machine knows how to
 * repair — so a spec change always lands on `NONE` there.
 *
 * Deliberately without an "unknown" member: absence carries it, and every
 * reader must treat an absent value as a call to leave to a human.
 */
export const SpecChangeKindSchema = z.enum(["FEATURE_REMOVED", "BEHAVIOUR_CHANGED"]);
export type SpecChangeKind = z.infer<typeof SpecChangeKindSchema>;

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
  /**
   * Which half of the test case is stale, and therefore how it is repaired
   * (see `DriftSurfaceSchema`). Set only for TEST_DRIFT / SPEC_CHANGE — the
   * other causes are not about the test case at all. Optional so a report
   * written before this field existed stays valid.
   */
  surface: DriftSurfaceSchema.optional(),
  /**
   * See `SpecChangeKindSchema`. Declared here because an audit's verdict
   * travels in a report row's `analysis`, which is parsed by this schema —
   * today only the audit sets it.
   */
  specChangeKind: SpecChangeKindSchema.optional(),
});
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;

/**
 * What a drift audit may conclude, in the same vocabulary `ccqa run
 * --on-fail-explain` uses for a failure. One question, one answer, the same
 * words whether it was reached by running the spec or by reading the code — so
 * a reader never translates between two taxonomies, and the hub renders,
 * grades and learns from both through one path.
 *
 * `PRODUCT_BUG` is deliberately absent. Drift never opens a browser, so "the
 * product regressed" is not something it can observe: a static read cannot
 * tell a dropped side effect from a working one. Claiming it would be guessing
 * in the one direction that wastes a developer's time. Unifying the vocabulary
 * means sharing the definitions, not emitting every label.
 */
export const DriftLabelSchema = PredictedLabelSchema.extract([
  ...DRIFT_FAILURE_CAUSES,
  "UNKNOWN",
]);
export type DriftLabel = z.infer<typeof DriftLabelSchema>;

/**
 * The finer-grained kinds a static read can distinguish. `TIMING_ISSUE` and
 * `DATA_MISSING` are runtime observations and stay out for the same reason
 * `PRODUCT_BUG` does.
 */
export const DriftSubDiagnosisSchema = z
  .enum(SUB_DIAGNOSES)
  .extract(["SELECTOR_DRIFT", "OVER_ASSERTION", "NONE"]);

/**
 * One spec's drift verdict. Shaped to match `FailureAnalysisSchema` field for
 * field, so it can travel in a report's `analysis` and be rendered by the
 * diagnosis card the failure path already has.
 *
 * Lives here rather than `src/drift/types.ts` (which re-exports it) because it
 * narrows this module's vocabulary, which that one already imports.
 */
export const DriftDiagnosisSchema = z.object({
  label: DriftLabelSchema,
  confidence: z.number().min(0).max(1),
  /** Where the drift is, which decides how it is repaired. See `DriftSurfaceSchema`. */
  surface: DriftSurfaceSchema.default("spec"),
  subDiagnosis: DriftSubDiagnosisSchema.default("NONE"),
  /** See `SpecChangeKindSchema`. */
  specChangeKind: SpecChangeKindSchema.optional(),
  /** One line: what is out of sync. */
  headline: z.string(),
  /** What to change to bring them back in sync. */
  recommendation: z.string().default(""),
  /** file:line references backing the claim. A label without one is not earned. */
  evidence: z.array(FailureEvidenceSchema),
  /**
   * How the label was reached, in prose. Carried for the same reason failure
   * analysis carries it: the diagnosis card shows it, and a reader deciding
   * whether to trust a label needs the argument, not only the conclusion.
   */
  reasoning: z.string().default(""),
});
export type DriftDiagnosis = z.infer<typeof DriftDiagnosisSchema>;

/**
 * `specChangeKind` names which repair a `SPEC_CHANGE` needs, so under any other
 * label it is dropped. Dropped rather than rejected — a stray value must not
 * cost an otherwise usable verdict.
 *
 * Two producers apply it. `ccqa audit` normalizes at the parse boundary
 * (`src/drift/analyze.ts`), so every consumer of a verdict it produced — the
 * JSON output, the report rows, the hub push — is clean by construction. The
 * hub normalizes rows on the way into the drift ledger, which is what a
 * foreign client's push passes through.
 *
 * What does NOT hold: a pushed report's stored archive is kept verbatim and
 * served back unchanged, so a row a foreign client wrote can still carry a
 * stray field. That is why the UI re-checks the label before rendering the
 * chip rather than trusting the stored row.
 */
export function normalizeDiagnosis<T extends { label: string; specChangeKind?: SpecChangeKind }>(
  diagnosis: T,
): T {
  if (diagnosis.label === "SPEC_CHANGE" || diagnosis.specChangeKind === undefined) return diagnosis;
  const { specChangeKind: _dropped, ...rest } = diagnosis;
  return rest as T;
}

export const ReportAssertionSchema = z.object({
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number().nullable(),
});
export type ReportAssertion = z.infer<typeof ReportAssertionSchema>;

/**
 * Step-boundary evidence captured at runtime by the script-driven test paths:
 * `abStepEvidence()` for agent-browser replays, `ccqa/step-evidence` for
 * external targets' generated tests. The path fields are relative to the
 * report directory so consumers (the hub UI, CI tooling) can resolve the PNGs
 * without duplicating their (potentially large) bytes inline.
 */
export const ReportEvidenceSchema = z.object({
  stepId: z.string(),
  source: z.string(),
  /** The step's closing (or, for a step that never completed, only) screenshot. */
  pngPath: z.string(),
  /**
   * Screenshot taken when the step was entered, for producers that shoot both
   * boundaries. Optional/nullable: agent-browser captures one shot per step,
   * and reports written before this field existed stay valid.
   */
  beforePngPath: z.string().nullable().optional(),
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
 * Everything one spec's measurement could not place.
 *
 * These are load-bearing, not diagnostics. An execution nobody could attribute
 * is indistinguishable from one that never happened, and "never happened" is
 * the answer this measurement exists to produce — so each way of losing one is
 * counted separately and shown next to the result (ADR-0020).
 */
export const CoverageGapsSchema = z.object({
  /** Server executions that ran while this spec was open but outside its context. */
  unattributed: z.number(),
  /** Browser scripts that ran but could not be traced back to a source file. */
  unmappedScripts: z.number(),
  /** Executed ranges that mapped to no original source. */
  unmappedRanges: z.number(),
  /** Browser sources that resolved to a path the project does not contain. */
  outsideProject: z.number(),
  /** Browser sources whose name could not be turned into a project path at all. */
  unresolvedSources: z.number(),
  /** Server files the instrumentation could not rewrite — they can never report. */
  uninstrumentedFiles: z.number(),
  /**
   * Application processes that instrumented nothing at all. One of these hides
   * every file the process ran, so it is never folded into the file count.
   */
  uninstrumentedProcesses: z.number(),
  /** Pushes the application could not deliver to the sink while this run was measuring. */
  droppedPushes: z.number(),
  /**
   * Events from identities the project never declared — other traffic on a
   * shared environment. Their reach belongs to no spec, and the identity itself
   * is dropped on arrival rather than recorded.
   */
  unmappedActorEvents: z.number().default(0),
  /**
   * Events from a declared identity that arrived outside every turn this run
   * gave it. Something other than the run drove that identity, and what it
   * reached is missing from a spec whose row otherwise looks complete.
   */
  outsideWindowEvents: z.number().default(0),
});
export type CoverageGaps = z.infer<typeof CoverageGapsSchema>;

/**
 * What one spec's execution actually reached: V8's own counters for the
 * browser and per-request instrumentation for the server, unioned on the spec
 * id both sides carry (ADR-0020).
 *
 * `backendReported` / `frontendReported` separate "reached nothing" from "that
 * half never answered", which otherwise render identically as zero.
 */
export const ReportCoverageSchema = z.object({
  /** Union of both sides, as project-relative posix paths. */
  files: z.array(z.string()),
  frontendFiles: z.number(),
  backendFiles: z.number(),
  /** Whether any instrumented application process reported during this run. */
  backendReported: z.boolean(),
  /** Whether the browser hooks produced a result for this spec. */
  frontendReported: z.boolean(),
  /** Whether browser collection died mid-spec, so what follows was never seen. */
  frontendStopped: z.boolean(),
  /**
   * Identities this spec acted as, and how many of their events it was credited
   * with. Present and zero when a declared identity produced nothing — which is
   * the difference between "the flow reached nothing" and "nothing reached us".
   */
  actorWindows: z.array(z.object({ key: z.string(), events: z.number() })).default([]),
  /**
   * Browser sources dropped because they are dependency code. Outside `gaps`
   * deliberately: nobody writes a test because a library file went unreached,
   * and mixed in with the real holes it buries them under its own magnitude.
   */
  excludedDependencies: z.number(),
  gaps: CoverageGapsSchema,
});
export type ReportCoverage = z.infer<typeof ReportCoverageSchema>;

/**
 * Per-step / per-run cost+usage record, pulled from the SDK's `result` message.
 * Every numeric field is nullable so the report can carry partial telemetry
 * (e.g. when the SDK omits a field, or when a step was skipped).
 *
 * `models` is the union of model ids the SDK reported using; usually a
 * single element, but the SDK can fan out across models in some modes.
 */
export const ReportCostSchema = z.object({
  totalCostUsd: z.number().nullable(),
  durationApiMs: z.number().nullable(),
  numTurns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  models: z.array(z.string()),
});
export type ReportCost = z.infer<typeof ReportCostSchema>;

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
  cost: ReportCostSchema,
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
  cost: ReportCostSchema,
});
export type LiveReportRun = z.infer<typeof LiveReportRunSchema>;

/**
 * What a second attempt at a failed spec showed (`--on-fail-explain-rerun`).
 * "passed" means the failure did not reproduce, which is the evidence a single
 * run cannot hold; "failed" means it did.
 *
 * The row's `status` never moves with it. The spec failed, and a passing second
 * attempt explains that failure rather than undoing it.
 */
export const ReportRerunSchema = z.object({
  outcome: z.enum(["passed", "failed"]),
});
export type ReportRerun = z.infer<typeof ReportRerunSchema>;

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
   * How the spec is defined, independent of whether anything ran. A normal run
   * reveals this through `liveRun`, but a drift audit executes nothing and
   * still needs to say it: a deterministic spec has two surfaces to check
   * (the spec and the code compiled from it) and a live one has a single
   * surface, so it states how much of the test case was examined. Optional so
   * reports written before this field existed stay valid.
   */
  mode: z.enum(["deterministic", "live"]).optional(),
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
  /**
   * How long the spec took — but the clock differs by execution path, so do
   * NOT compare it across targets:
   *   - agent-browser deterministic: the SUM of the vitest assertion durations
   *     (not wall time; excludes fixture/setup between assertions).
   *   - external (runCommand) target: the whole command's wall-clock time
   *     (process spawn to exit — includes the tool's own startup).
   *   - agent-browser live: the run's wall-clock time, mirroring
   *     `liveRun.durationMs`.
   * Null when no timing was available.
   */
  durationMs: z.number().nullable(),
  /** Per-test rows from the vitest JSON report (Playwright-style step list). */
  assertions: z.array(ReportAssertionSchema).nullable(),
  /** Present only for failed specs that were analyzed. */
  analysis: FailureAnalysisSchema.nullable(),
  /** Human-readable reason when a failed spec was NOT analyzed (no auth, no spec.yaml, ...). */
  analysisSkipped: z.string().nullable(),
  /**
   * See {@link ReportRerunSchema}. Present only on a row a second attempt was
   * spent on; optional (not nullable) so older report.json stays valid
   * byte-for-byte.
   */
  rerun: ReportRerunSchema.optional(),
  /**
   * The `triage.agent` overlay version actually applied to THIS row's
   * failure analysis. Per-row (not just per-run) because per-target overlays
   * mean different specs of one run can use different overlays; the envelope's
   * `customPromptVersion` records only the un-scoped fallback. Optional (omitted
   * when no overlay was injected) so older report.json stays valid byte-for-byte.
   */
  customPromptVersion: z.string().optional(),
  /**
   * The baseline THIS spec's diff was taken against. Matches the envelope's
   * git.base for fixed baselines; with per-spec last-green baselines each
   * spec has its own (the commit where it last passed). Optional so older
   * report.json stays valid; absent when no diff context was resolved.
   */
  analysisBase: z.object({ ref: z.string(), sha: z.string() }).nullable().optional(),
  // A `driftAudit` field used to sit here, holding the separate audit a run
  // made before classifying. Dropped with that call: on a run row it could
  // now only ever be null, which reads as "the audit found nothing" rather
  // than "no audit ran". Older report.json still parses — zod strips it.
  failureLogExcerpt: z.string().nullable(),
  diffExcerpt: z.string().nullable(),
  specYaml: z.string().nullable(),
  /** Step-boundary screenshots for the script-driven (`ccqa run`) paths, in capture order. */
  evidence: z.array(ReportEvidenceSchema).nullable(),
  /**
   * Why this row has no step screenshots — a target that cannot produce them
   * (an API runbook has no browser), or a generated test that lost its capture
   * calls. Lets the report say so instead of rendering an empty section.
   * Optional (not nullable — producers set a string or omit it) so older
   * report.json stays valid byte-for-byte.
   */
  evidenceUnavailable: z.string().optional(),
  /**
   * Generic run artifacts for external (runCommand) target specs: the
   * command's `output.log` plus whatever it wrote into `{artifactsDir}`.
   * Optional (not nullable) so report.json written before this field existed
   * stays valid byte-for-byte.
   */
  artifacts: z.array(ReportArtifactSchema).optional(),
  /**
   * Present when the run measured coverage (`--coverage`). Optional (not
   * nullable) so report.json written before this field existed stays valid
   * byte-for-byte.
   */
  coverage: ReportCoverageSchema.optional(),
  /**
   * Why this row has no coverage — a target whose generated tests carry no
   * coverage hooks. Says so instead of showing an empty file set, which reads
   * as "this spec reached nothing".
   */
  coverageUnavailable: z.string().optional(),
  /**
   * Set for specs executed in live mode (`mode: live`). The renderer shows the
   * per-step verdicts + before/after screenshots instead of (or in addition
   * to) the vitest assertion list. `assertions` is null for live-only specs.
   */
  liveRun: LiveReportRunSchema.nullable(),
});
export type ReportSpecResult = z.infer<typeof ReportSpecResultSchema>;

/**
 * Which rule produced the analysis baseline: "explicit" (a value was
 * passed), "github-base-ref" (derived from a pull_request event), or
 * "last-green" (per-spec baselines from the hub ledger — `baseSha` is then
 * null and each analyzed row carries its own `analysisBase`). Lets accuracy
 * numbers be stratified by baseline provenance. Single source of truth —
 * `src/run/git-context.ts`'s `BaseSource` type and the hub's PATCH schema
 * both derive from this.
 */
export const BaseSourceSchema = z.enum(["explicit", "github-base-ref", "last-green"]);
export type BaseSource = z.infer<typeof BaseSourceSchema>;

/** The report envelope's git block; also referenced by the hub's PATCH reportMeta schema. */
export const GitEnvelopeSchema = z.object({
  /**
   * Full HEAD sha, recorded unconditionally (independent of whether a diff
   * was captured). Null only when the run executed outside a git repo, or
   * for report.json written before this guarantee existed.
   */
  head: z.string().nullable(),
  /**
   * The failure-analysis baseline ref (`--on-fail-explain-base`); null
   * when analysis was not requested.
   */
  base: z.string().nullable(),
  /**
   * `base` resolved to a full commit sha at run start — the reproducible
   * form of the baseline (`origin/main` alone can't be re-resolved later).
   * Optional so older report.json stays valid.
   */
  baseSha: z.string().nullable().optional(),
  /** See {@link BaseSourceSchema}. Optional for older report.json. */
  baseSource: BaseSourceSchema.nullable().optional(),
});

export const RunReportDataSchema = z.object({
  schemaVersion: z.literal(1),
  /** Which command produced it. See {@link ReportKindSchema}. */
  kind: ReportKindSchema.default("run"),
  createdAt: z.string(),
  /** GITHUB_RUN_ID when running in Actions; null locally. Links the report back to its CI run. */
  runId: z.string().nullable(),
  /**
   * The GitHub Actions run URL (GITHUB_SERVER_URL/REPOSITORY/RUN_ID). Present
   * only when running in Actions; omitted (not null) locally so report.json
   * written outside CI stays byte-for-byte identical to before this field.
   */
  runUrl: z.string().nullable().optional(),
  git: GitEnvelopeSchema,
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
  /**
   * The commit the target environment was running when this run *started*,
   * read from the hub's deploy log for `--profile` (ADR-0010). `ccqa hub push`
   * forwards it as `?deployedSha=` so a deploy landing mid-run can't be
   * mistaken for the run's baseline. Absent (not null) when there was no hub,
   * no profile or no deploy log, which keeps report.json byte-identical to
   * before this field existed.
   */
  deployedSha: z.string().optional(),
  /**
   * What this invocation spent on Claude, as of the moment report.json was
   * written. Every call counts: live browsing, failure triage, the drift audit
   * a failure triggers, and spec selection. It is therefore a superset of the
   * per-spec `results[].liveRun.cost`, not a sum of them.
   *
   * "Nothing was billed" is `totalCostUsd: null` inside this object, NOT a
   * null object — a deterministic run that passes still carries a `cost` whose
   * every numeric field is null. The object itself is null only for a report
   * built outside a cost scope (a library caller of `executeRun`, a test) and
   * for report.json written before this field, which `.default(null)` keeps
   * valid. Read the total, not the object's presence.
   */
  cost: ReportCostSchema.nullable().default(null),
  results: z.array(ReportSpecResultSchema),
});
export type RunReportData = z.infer<typeof RunReportDataSchema>;

/** Shape of the "export labels" download produced by the report's client-side JS. */
export const LabelEntrySchema = z.object({
  feature: z.string(),
  spec: z.string(),
  predicted: PredictedLabelSchema,
  label: ActualCauseSchema,
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
