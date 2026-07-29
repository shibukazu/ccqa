import type {
  DeployEntry,
  DeployInput,
  DeployLog,
  DriftLedger,
  LearningJob,
  Run,
  RunStatus,
  SpecLedger,
  SpecLocks,
  SpecTouchIndex,
} from "../../contract/schema.ts";

/**
 * Everything the hub persists, behind one interface. `createHubStorage`
 * (factory.ts) is the only place that knows which concrete backend is in
 * use — v1 ships a local-directory implementation (`file/`); a future
 * backend (SQLite, a remote DB) implements the same sub-stores and plugs
 * into the factory without touching the API layer.
 *
 * Every value that could be a secret (session state, variable values)
 * crosses this boundary as an opaque `Uint8Array` — encryption happens one
 * layer up (`core/crypto.ts`), so swapping the storage backend never
 * touches how secrets are protected.
 */
export interface HubStorage {
  runs: RunStore;
  artifacts: ArtifactStore;
  sessions: SecretStore;
  variables: SecretStore;
  triage: TriageStore;
  prompts: PromptStore;
  perspectives: PerspectivesStore;
  jobs: JobStore;
  ledger: SpecLedgerStore;
  driftLedger: DriftLedgerStore;
  deploys: DeployStore;
  locks: LockStore;
}

/**
 * The spec ledger: per (project, profile, branch), three maps of
 * "feature/spec" → the run that last left the spec green / ran it at all /
 * left it red. Branch-scoped so a green on a PR branch never becomes the
 * baseline for the default branch — readers overlay their branch's document
 * onto the default branch's.
 */
export interface SpecLedgerStore {
  get(project: string, profile: string, branch: string): Promise<SpecLedger>;
  /**
   * Every branch's document for one (project, profile), merged newest-`at`
   * wins per key. Re-run selection is scoped (project, profile, spec) with no
   * branch: a run exercises the deployed environment whatever branch its code
   * came from, so all of them count.
   */
  getMerged(project: string, profile: string): Promise<SpecLedger>;
  /** Upsert the given buckets; per bucket and key, an entry only advances (newer `at` wins). */
  merge(project: string, profile: string, branch: string, ledger: SpecLedger): Promise<void>;
}

/**
 * The drift ledger: per (project, branch), "feature/spec" → its last audit
 * from a `kind: "drift"` run. No profile — see `SpecDriftEntrySchema`. Branch
 * is kept for the same reason the spec ledger keeps it (a PR branch's audits
 * shouldn't become the default branch's baseline); readers merge across every
 * branch, newest-`at` per key, the same approximation `SpecLedgerStore.getMerged`
 * makes.
 */
export interface DriftLedgerStore {
  getMerged(project: string): Promise<DriftLedger>;
  /** Upsert the given entries; per key, an entry only advances (newer `at` wins). */
  merge(project: string, branch: string, ledger: DriftLedger): Promise<void>;
}

/**
 * The per-(project, profile) deploy log the consumer's deploy job pushes into,
 * plus the touch index derived from it (ADR-0010).
 */
export interface DeployStore {
  /** Append one deploy, assigning its position and flagging a gap when it doesn't chain onto the head. */
  append(project: string, profile: string, input: DeployInput): Promise<DeployEntry>;
  getLog(project: string, profile: string): Promise<DeployLog>;
  /** The newest entry, or null when nothing has been recorded for this profile. */
  head(project: string, profile: string): Promise<DeployEntry | null>;
  /**
   * Mark an entry's selection as recorded. Written only after the fold lands,
   * so the flag never claims a selection the touch index does not hold.
   */
  confirmSelection(project: string, profile: string, index: number): Promise<void>;
  getTouchIndex(project: string, profile: string): Promise<SpecTouchIndex>;
  /** Serialized read-modify-write, so two concurrent deploys can't clobber each other's folds. */
  updateTouchIndex(
    project: string,
    profile: string,
    mutate: (current: SpecTouchIndex) => SpecTouchIndex,
  ): Promise<void>;
}

/**
 * Per (project, profile), which job is working on which spec. Profile-scoped
 * because a job targets one deployed environment, even though the drift
 * verdict it produces is not (ADR-0013).
 */
export interface LockStore {
  get(project: string, profile: string): Promise<SpecLocks>;
  /** Serialized read-modify-write, so two jobs cannot both win the same spec. */
  update(
    project: string,
    profile: string,
    mutate: (current: SpecLocks) => SpecLocks,
  ): Promise<SpecLocks>;
}

export interface RunStore {
  /** Create once — used both by an immutable push and by opening a mutable "running" run. */
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  /** Mutable while running; immutable once terminal (enforced by the API layer, not the store). */
  update(id: string, patch: Partial<Run>): Promise<Run>;
  /** Newest first, optionally filtered by project / branch / status. */
  list(q: { project?: string; branch?: string; status?: RunStatus; limit?: number }): Promise<Run[]>;
  /** Distinct project names across all stored runs. Feeds `GET /projects`. */
  listProjects(): Promise<string[]>;
}

/** A run's report directory (report.json + evidence/*.png) as the client pushed it. */
export interface ArtifactStore {
  /** Recursively copies every file under `srcDir` into the run's artifact tree. */
  putDir(runId: string, srcDir: string): Promise<void>;
  read(runId: string, relPath: string): Promise<Uint8Array | null>;
  /** Every stored file, tarred and gzipped, for bulk download. Null when nothing was stored. */
  readTarGz(runId: string): Promise<Uint8Array | null>;
  listFiles(runId: string): Promise<string[]>;
  /** Write-once evidence file (e.g. a step PNG) under the run's artifact tree. */
  putFile(runId: string, relPath: string, bytes: Uint8Array): Promise<void>;
  /** Concurrency-safe read-modify-write for a JSON artifact (e.g. report.json). */
  updateJsonFile<T>(runId: string, relPath: string, mutate: (current: T | null) => T): Promise<void>;
}

/**
 * Where a secret lives: one hub manages many projects (one per consuming
 * `.ccqa` tree), and within a project secrets are grouped by profile
 * (stg / prd / default, mirroring `.ccqa/profiles/<name>.env` locally).
 */
export interface SecretScope {
  project: string;
  profile: string;
}

/** Opaque encrypted-blob storage for sessions and variables — same shape, different kind namespace. */
export interface SecretStore {
  put(scope: SecretScope, name: string, blob: Uint8Array, meta?: Record<string, unknown>): Promise<void>;
  get(scope: SecretScope, name: string): Promise<{ blob: Uint8Array; meta: Record<string, unknown> } | null>;
  list(scope: SecretScope): Promise<{ name: string; meta: Record<string, unknown>; updatedAt: string }[]>;
  delete(scope: SecretScope, name: string): Promise<void>;
  /** Distinct project names that have at least one secret of this kind. Feeds `GET /projects`. */
  listProjects(): Promise<string[]>;
  /** Distinct profile names under a project that have at least one secret of this kind. Feeds `GET /projects/:project/profiles`. */
  listProfiles(project: string): Promise<string[]>;
}

/** One human-recorded "actual cause" for a failing spec, keyed by (runId, feature, spec). */
export interface TriageRecord {
  feature: string;
  spec: string;
  predicted: { label: string; confidence: number; subDiagnosis?: string; headline: string };
  actualCause: string;
  note?: string;
  /**
   * Generation target of the graded row ("agent-browser", "playwright", ...).
   * Lets the confusion matrix be read per target and keeps the target with the
   * case metadata a future per-target overlay split would key on. Optional so
   * records written before this field stay valid.
   */
  target?: string;
  promptVersion: string;
  recordedAt: string;
}

export interface TriageStore {
  /** Upsert by (runId, feature, spec) — re-recording a case overwrites the previous entry. */
  putActualCause(runId: string, record: TriageRecord): Promise<void>;
  deleteActualCause(runId: string, feature: string, spec: string): Promise<void>;
  list(runId: string): Promise<TriageRecord[]>;
}

/**
 * Triage-learning jobs. Unlike runs (immutable once pushed), a job is mutated
 * as the queue works it: created "queued", flipped to "running", then to
 * "succeeded"/"failed". `update` must serialize its read-modify-write so a
 * status poll and the worker's write can't clobber each other.
 */
export interface JobStore {
  create(job: LearningJob): Promise<void>;
  get(id: string): Promise<LearningJob | null>;
  update(id: string, patch: Partial<LearningJob>): Promise<LearningJob>;
  /** Newest first, optionally filtered by project / profile. */
  list(q: { project?: string; profile?: string; limit?: number }): Promise<LearningJob[]>;
}

/**
 * Prompt assets stored per project: the record/live guidance bundle and the
 * analysis custom prompt. Unlike secrets (which are profile-scoped, since a profile
 * is a set of env vars), prompts are project-wide — the same guidance applies
 * across every profile a project runs against. The blob is plain UTF-8 text
 * (Markdown or custom prompt JSON) with no encryption — prompts are not secret, so
 * this works with no `CCQA_HUB_ENCRYPTION_KEY`. The name is one of the reserved
 * `PromptName`s (see src/prompts/prompt-names).
 */
export interface PromptStore {
  put(project: string, name: string, blob: Uint8Array, meta?: Record<string, unknown>): Promise<void>;
  get(project: string, name: string): Promise<{ blob: Uint8Array; meta: Record<string, unknown> } | null>;
  list(project: string): Promise<{ name: string; meta: Record<string, unknown>; updatedAt: string }[]>;
  delete(project: string, name: string): Promise<void>;
  /** Distinct project names that have at least one stored prompt. Feeds `GET /projects`. */
  listProjects(): Promise<string[]>;
}

/**
 * The per-project perspectives document — `ccqa perspectives`' coverage
 * inventory, stored on the hub only (never in the consuming repo). One JSON
 * blob per project; the document carries its own `generatedAt`, so there is
 * no separate meta. Plain UTF-8, no encryption — an inventory of what is
 * tested is not a secret.
 */
export interface PerspectivesStore {
  put(project: string, blob: Uint8Array): Promise<void>;
  get(project: string): Promise<Uint8Array | null>;
  /**
   * Serialized read-modify-write on the stored JSON document (the UI's note
   * editing) — two concurrent edits must not clobber each other. `mutate`
   * receives the parsed document (`null` when none is stored) and returns
   * what to write; a throw aborts without writing.
   */
  update(project: string, mutate: (current: unknown | null) => unknown): Promise<void>;
  delete(project: string): Promise<void>;
}
