import type { LearningJob, Run, RunStatus } from "../../contract/schema.ts";

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
  jobs: JobStore;
}

export interface RunStore {
  /** A pushed run is immutable — there is no update; it is created once and only read afterward. */
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
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
