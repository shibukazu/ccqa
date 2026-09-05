import type {
  CoverageEdgesDoc,
  CoverageEdgesUpsert,
  AcquireLocksRequest,
  AcquireLocksResponse,
  AttestationResponse,
  AttestationsResponse,
  AuditDismissalResponse,
  AuditDismissalsResponse,
  AuditNeedReport,
  DeployEntry,
  DeployLogResponse,
  DriftLedgerResponse,
  ImportActualCausesResponse,
  LastGreenEntry,
  PutActualCauseRequest,
  RecordDeployRequest,
  RecordSpendRequest,
  RerunReport,
  Run,
  RunStatus,
  RunTriage,
  SpendEntry,
  SpendLogResponse,
  TriageCase,
} from "../hub/contract/schema.ts";
import type { ResolvedCoverage } from "../coverage/resolve-stream.ts";
import type { PromptName } from "../prompts/prompt-names.ts";
import type { LabelsExport, ReportSpecResult } from "../report/schema.ts";
import type { ReportEnvelope } from "../run/incremental-report.ts";

/**
 * Body of a `PATCH /runs/:id` incremental push: the newly-finished spec rows,
 * their evidence PNGs (posix relPath → base64), the report envelope metadata
 * (filled once the real git diff is known), and — on the last patch — `done`
 * with the terminal status.
 */
export interface PatchRunRequest {
  rows: ReportSpecResult[];
  /** reportDir-relative posix path → base64 PNG bytes. */
  evidence?: Record<string, string>;
  done?: boolean;
  finalStatus?: "passed" | "failed";
  reportMeta?: Partial<ReportEnvelope>;
}

/**
 * TypeScript client for the ccqa hub's public REST API (docs/hub-api.md).
 * Uses the global `fetch` only — no `node:*` imports — so this same module
 * works unmodified as a browser bundle (an intranet dashboard) or in a
 * Node script (the `ccqa hub push/pull` CLI, which is itself just one more
 * consumer of this client).
 */

export interface HubClientOptions {
  baseUrl: string;
  token: string;
  /**
   * Extra headers sent on every request, ahead of any per-call headers and
   * the `Authorization` header (e.g. an infra gateway/ALB bypass header in
   * CI — never overrides `Authorization`).
   */
  headers?: Record<string, string>;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class HubApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface HubVariable {
  name: string;
  sensitive: boolean;
  updatedAt: string;
  value?: string;
}

export interface HubPromptMeta {
  name: string;
  kind: "guidance" | "custom-prompt";
  updatedAt: string;
  meta: Record<string, unknown>;
}

/**
 * What `GET /api/v1/coverage` answers: one run's resolved view of the
 * project's coverage event stream, plus every run the stream retains (newest
 * first, bounded server-side). `resolved` is null when the stream holds no
 * measured run.
 */
export interface HubCoverageAnswer {
  resolved: ResolvedCoverage | null;
  runIds: string[];
}

export interface HubClient {
  /**
   * Push a report directory (as a tar.gz) for an already-finished `ccqa run`.
   *
   * `deployedSha` asserts the commit the environment was running *when the run
   * started*. Without it the hub falls back to its deploy-log head, which by
   * push time is the head after the run — a deploy that landed mid-run would
   * then read as that run's baseline.
   */
  pushRun(
    archive: Uint8Array,
    meta: {
      project: string;
      branch?: string;
      profile?: string;
      kind?: Run["kind"];
      deployedSha?: string;
    },
  ): Promise<Run>;
  /**
   * Open a `running` run to push results into incrementally. Returns the new
   * run's id. Non-retryable (a dropped response after the server committed
   * would leave a second open run); callers degrade to local-only on failure.
   * `gitHead` stamps the run's commit at open time, so even a run that dies
   * before its final reconcile patch is attributable to a commit.
   *
   * `deployedSha` does the same for the environment's commit: the baseline the
   * caller selected against, which a `--rerun` inherits from an earlier run.
   * Left unset the hub reads its own deploy-log head, which by the time this
   * call lands can already name a later deploy.
   */
  openRun(meta: {
    project: string;
    branch?: string;
    profile?: string;
    kind?: Run["kind"];
    gitHead?: string;
    deployedSha?: string;
    /** CI run id (GITHUB_RUN_ID) and its run URL, stamped at open time so an
     *  interrupted incremental run still links back to its CI run. */
    ciRunId?: string;
    runUrl?: string;
  }): Promise<Run>;
  /** Add finished spec rows (+ evidence) to a running run; `done` closes it. */
  patchRun(id: string, body: PatchRunRequest): Promise<Run>;
  /** `ciRunId` answers "which runs did this CI job create", whatever the window. */
  listRuns(q?: {
    project?: string;
    branch?: string;
    status?: RunStatus;
    kind?: Run["kind"];
    ciRunId?: string;
    limit?: number;
  }): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  getReport(id: string): Promise<unknown>;
  downloadArtifacts(id: string): Promise<Uint8Array>;

  /**
   * The project's coverage event stream, resolved for one run — `runId`
   * omitted means the most recently measured run. Spec selection reads its
   * reach edges through this (ADR-0024).
   */
  getCoverage(project: string, q?: { runId?: string }): Promise<HubCoverageAnswer>;
  /**
   * Merge one run's measured reach into the project's coverage-edge ledger
   * (ADR-0026). The hub stamps `measuredAt` with its own clock.
   */
  putCoverageEdges(project: string, upsert: CoverageEdgesUpsert): Promise<void>;
  /** The coverage-edge ledger, or `null` when nothing is stored (or the hub predates it). */
  getCoverageEdges(project: string): Promise<CoverageEdgesDoc | null>;

  /**
   * Source maps for what a commit deployed, addressed by the asset path the
   * browser requests. Coverage falls back to these when the build keeps its
   * maps out of the CDN, which is the usual choice — a map hands out source.
   */
  putSourceMap(project: string, commit: string, assetPath: string, map: Uint8Array): Promise<void>;
  getSourceMap(project: string, commit: string, assetPath: string): Promise<string | null>;
  listSourceMaps(project: string, commit: string): Promise<string[]>;
  /** Ends a push, letting the hub drop the commits it no longer keeps. */
  sweepSourceMaps(project: string): Promise<void>;

  getTriage(id: string): Promise<RunTriage>;
  putActualCause(
    id: string,
    c: { feature: string; spec: string },
    v: PutActualCauseRequest,
  ): Promise<TriageCase>;
  deleteActualCause(id: string, c: { feature: string; spec: string }): Promise<void>;
  importActualCauses(id: string, labels: LabelsExport): Promise<ImportActualCausesResponse>;

  /** Every project the hub knows (from runs and stored secrets). */
  listProjects(): Promise<string[]>;

  /**
   * The last-green ledger for one project/profile: "feature/spec" → the run
   * head where that spec last passed. `branch` entries overlay
   * `fallbackBranch` (typically the default branch) entries server-side.
   */
  getLastGreen(
    project: string,
    q: { profile?: string; branch: string; fallbackBranch?: string },
  ): Promise<Record<string, LastGreenEntry>>;

  /**
   * Per spec of one project/profile: is its last result still trustworthy?
   * Answers `ccqa run --only-hub-rerun-needed`. 404 when the project has no
   * perspectives document — there is then no spec registered to compare
   * against a deploy, which the caller must report rather than read as
   * "nothing to run".
   */
  getRerun(project: string, q: { profile: string }): Promise<RerunReport>;
  /**
   * Per spec of one project/profile: has a deploy landed on the code it covers
   * since the audit last read it? Answers `ccqa audit
   * --only-hub-audit-needed`. 404 on a project with no perspectives document,
   * for the same reason `getRerun` does.
   */
  getAuditNeed(project: string, q: { profile: string }): Promise<AuditNeedReport>;
  /**
   * Take the specs that are free, so a second job does not start on one this
   * run is already working. `denied` is part of the answer, not an error.
   */
  acquireLocks(project: string, q: { profile: string }, body: AcquireLocksRequest): Promise<AcquireLocksResponse>;
  /** Drop everything `runId` holds. Safe to call when it holds nothing. */
  releaseLocks(project: string, q: { profile: string }, holder: string): Promise<void>;
  /** Every attestation for the profile, standing and lapsed alike. */
  getAttestations(project: string, q: { profile: string }): Promise<AttestationsResponse>;
  /** Record that a person checked `spec` by hand. The hub stamps the time and deploy head. */
  putAttestation(
    project: string,
    q: { profile: string },
    body: { spec: string; by: string; note?: string },
  ): Promise<AttestationResponse>;
  /** Revoke a spec's attestation. Revoking one that does not exist succeeds. */
  deleteAttestation(project: string, q: { profile: string }, spec: string): Promise<void>;
  /** Every dismissed audit finding for the project, current and superseded alike. No profile — findings are about the repository. */
  getAuditDismissals(project: string): Promise<AuditDismissalsResponse>;
  /**
   * Record that a person judged `spec`'s current audit finding wrong. The hub
   * reads which finding that is from the ledger and pins the dismissal to it;
   * a spec with no open finding is rejected.
   */
  putAuditDismissal(project: string, body: { spec: string; by: string; note: string }): Promise<AuditDismissalResponse>;
  /** Withdraw a dismissal, putting the audit's finding back in force. */
  deleteAuditDismissal(project: string, spec: string): Promise<void>;
  /**
   * Every spec's last `ccqa audit --report-to-hub` result, keyed by "feature/spec". No
   * profile — drift asks whether a spec still describes the code, not
   * whether an environment is stale.
   */
  getDriftLedger(project: string): Promise<DriftLedgerResponse>;
  /** Tell the hub what a deploy shipped (`ccqa hub deploy record`). */
  recordDeploy(project: string, profile: string, body: RecordDeployRequest): Promise<DeployEntry>;
  /** The profile's retained deploy log, oldest first; `limit` keeps the newest N. */
  getDeployLog(project: string, q: { profile: string; limit?: number }): Promise<DeployLogResponse>;

  /**
   * Report what one batch of ccqa invocations cost (`ccqa hub cost push`).
   * Read instead of a sum over runs, never alongside one (ADR-0017).
   */
  recordSpend(project: string, body: RecordSpendRequest): Promise<SpendEntry>;
  /** The project's spend over `[since, until)`, newest first, with the window's total. */
  getSpend(project: string, q?: { since?: string; until?: string }): Promise<SpendLogResponse>;

  putSession(project: string, profile: string, name: string, storageState: unknown): Promise<void>;
  getSession(project: string, profile: string, name: string): Promise<unknown>;
  listSessions(project: string, profile: string): Promise<{ name: string; updatedAt: string }[]>;
  deleteSession(project: string, profile: string, name: string): Promise<void>;

  putVariable(project: string, profile: string, name: string, v: { value: string; sensitive: boolean }): Promise<void>;
  listVariables(project: string, profile: string, opts?: { includeValues?: boolean }): Promise<HubVariable[]>;
  deleteVariable(project: string, profile: string, name: string): Promise<void>;

  putPrompt(project: string, name: PromptName, body: string): Promise<void>;
  getPrompt(project: string, name: PromptName): Promise<string | null>;
  listPrompts(project: string): Promise<HubPromptMeta[]>;
  deletePrompt(project: string, name: PromptName): Promise<void>;

  /** The project's perspectives document (coverage inventory), stored hub-only. */
  putPerspectives(project: string, doc: unknown): Promise<void>;
  getPerspectives(project: string): Promise<unknown | null>;
  /** Set (or clear, with an empty string) the human note on one spec's entry. */
  patchPerspectivesNote(project: string, c: { feature: string; spec: string; note: string }): Promise<void>;
  deletePerspectives(project: string): Promise<void>;
}

/** Per-attempt fetch timeout. Bounds how long a stalled socket can block a poll loop. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * HTTP methods safe to retry: GET is a pure read, and DELETE is idempotent
 * (deleting an already-deleted resource is a no-op, not a new side effect).
 * POST/PUT are never retried — a POST that "failed" after the server
 * already committed it (e.g. a dropped response to pushRun) would create a
 * duplicate run on retry, and PUT-driven imports would double-apply.
 */
const RETRYABLE_METHODS = new Set(["GET", "DELETE"]);

/** Fixed backoff between retry attempts, in ms. */
const RETRY_BACKOFF_MS = [100, 300, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throwHubApiError(res: Response): Promise<never> {
  let code = "unknown_error";
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body — fall back to statusText.
  }
  throw new HubApiError(res.status, code, message);
}

/**
 * One round trip against a hub, with the client's shared policy: bearer auth,
 * per-attempt timeout, retries for idempotent methods, `HubApiError` on the
 * final non-ok answer. Exported for the one caller outside the client
 * (`CoverageInbox`), whose POSTs are appends a duplicate cannot corrupt —
 * unlike the client's own POSTs — so it may opt into `retry: "post-once"`,
 * one extra attempt after a 5xx or network error.
 */
export async function hubRequest(
  opts: HubClientOptions,
  path: string,
  init: RequestInit = {},
  retry?: "post-once",
): Promise<Response> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const method = (init.method ?? "GET").toUpperCase();
  const maxAttempts =
    retry === "post-once" ? 2 : RETRYABLE_METHODS.has(method) ? RETRY_BACKOFF_MS.length + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Bound each attempt so a stalled/reused socket can't hang a poll loop
    // forever; a caller-supplied signal (e.g. user cancellation) wins.
    const signal = init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal,
        headers: { ...opts.headers, ...init.headers, Authorization: `Bearer ${opts.token}` },
      });
    } catch (err) {
      // Transient network/socket error (or timeout abort) — retry if allowed.
      if (attempt < maxAttempts - 1) {
        await sleep(RETRY_BACKOFF_MS[attempt]!);
        continue;
      }
      throw err;
    }
    if (res.ok) return res;
    if (res.status >= 500 && attempt < maxAttempts - 1) {
      await sleep(RETRY_BACKOFF_MS[attempt]!);
      continue;
    }
    // 4xx (or final attempt) — not retryable, or retries exhausted.
    return throwHubApiError(res);
  }
  // Unreachable: the loop always returns or throws.
  throw new Error("unreachable");
}

export function createHubClient(opts: HubClientOptions): HubClient {
  function request(path: string, init: RequestInit = {}): Promise<Response> {
    return hubRequest(opts, path, init);
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await request(path, init)).json() as Promise<T>;
  }

  async function bytes(path: string, init?: RequestInit): Promise<Uint8Array> {
    const buf = await (await request(path, init)).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function text(path: string, init?: RequestInit): Promise<string> {
    return (await request(path, init)).text();
  }

  function noBody(path: string, method: string): Promise<void> {
    return request(path, { method }).then(() => undefined);
  }

  function putJson(path: string, body: unknown): Promise<void> {
    return request(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(() => undefined);
  }

  return {
    pushRun(archive, meta) {
      const params = new URLSearchParams({ project: meta.project });
      if (meta.branch) params.set("branch", meta.branch);
      if (meta.profile) params.set("profile", meta.profile);
      if (meta.kind) params.set("kind", meta.kind);
      if (meta.deployedSha) params.set("deployedSha", meta.deployedSha);
      return json(`/api/v1/runs?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: toBodyInit(archive),
      });
    },
    openRun(meta) {
      const params = new URLSearchParams({ project: meta.project });
      if (meta.branch) params.set("branch", meta.branch);
      if (meta.profile) params.set("profile", meta.profile);
      if (meta.kind) params.set("kind", meta.kind);
      if (meta.gitHead) params.set("gitHead", meta.gitHead);
      if (meta.deployedSha) params.set("deployedSha", meta.deployedSha);
      if (meta.ciRunId) params.set("ciRunId", meta.ciRunId);
      if (meta.runUrl) params.set("runUrl", meta.runUrl);
      return json(`/api/v1/runs/open?${params}`, { method: "POST" });
    },
    patchRun(id, body) {
      return json(`/api/v1/runs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async listRuns(q = {}) {
      const params = queryString(q);
      const { runs } = await json<{ runs: Run[] }>(`/api/v1/runs?${params}`);
      return runs;
    },
    getRun(id) {
      return json(`/api/v1/runs/${encodeURIComponent(id)}`);
    },
    getReport(id) {
      return json(`/api/v1/runs/${encodeURIComponent(id)}/report`);
    },
    downloadArtifacts(id) {
      return bytes(`/api/v1/runs/${encodeURIComponent(id)}/artifacts`);
    },
    getCoverage(project, q = {}) {
      return json(`/api/v1/coverage?${queryString({ project, runId: q.runId })}`);
    },

    putCoverageEdges(project, upsert) {
      return request(`/api/v1/projects/${encodeURIComponent(project)}/coverage-edges`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(upsert),
      }).then(() => undefined);
    },
    async getCoverageEdges(project) {
      try {
        return await json<CoverageEdgesDoc>(`/api/v1/projects/${encodeURIComponent(project)}/coverage-edges`);
      } catch (err) {
        if (err instanceof HubApiError && err.status === 404) return null;
        throw err;
      }
    },

    putSourceMap(project, commit, assetPath, map) {
      return request(`${sourceMapPath(project, commit)}/${encodeAssetPath(assetPath)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: toBodyInit(map),
      }).then(() => undefined);
    },
    async getSourceMap(project, commit, assetPath) {
      try {
        return await text(`${sourceMapPath(project, commit)}/${encodeAssetPath(assetPath)}`);
      } catch (err) {
        // A commit that pushed no map for this asset answers 404. Anything
        // else — the hub down, a bad token — is not "no map" and has to stay
        // visible, or coverage silently reports less than it measured.
        if (err instanceof HubApiError && err.status === 404) return null;
        throw err;
      }
    },
    sweepSourceMaps(project) {
      return noBody(`/api/v1/projects/${encodeURIComponent(project)}/sourcemaps/sweep`, "POST");
    },
    async listSourceMaps(project, commit) {
      const { paths } = await json<{ paths: string[] }>(sourceMapPath(project, commit));
      return paths;
    },

    getTriage(id) {
      return json(`/api/v1/runs/${encodeURIComponent(id)}/triage`);
    },
    putActualCause(id, c, v) {
      return json(
        `/api/v1/runs/${encodeURIComponent(id)}/triage/${encodeURIComponent(c.feature)}/${encodeURIComponent(c.spec)}/actual-cause`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v) },
      );
    },
    deleteActualCause(id, c) {
      return noBody(
        `/api/v1/runs/${encodeURIComponent(id)}/triage/${encodeURIComponent(c.feature)}/${encodeURIComponent(c.spec)}/actual-cause`,
        "DELETE",
      );
    },
    importActualCauses(id, labels) {
      return json(`/api/v1/runs/${encodeURIComponent(id)}/triage/actual-causes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(labels),
      });
    },

    async getLastGreen(project, q) {
      const params = queryString({
        branch: q.branch,
        ...(q.profile ? { profile: q.profile } : {}),
        ...(q.fallbackBranch ? { fallbackBranch: q.fallbackBranch } : {}),
      });
      const { entries } = await json<{ entries: Record<string, LastGreenEntry> }>(
        `/api/v1/projects/${encodeURIComponent(project)}/last-green?${params}`,
      );
      return entries;
    },

    getRerun(project, q) {
      return json(`/api/v1/projects/${encodeURIComponent(project)}/rerun?${queryString({ profile: q.profile })}`);
    },
    acquireLocks(project, q, body) {
      return json(`${locksPath(project)}?${queryString({ profile: q.profile })}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async releaseLocks(project, q, holder) {
      await request(`${locksPath(project)}?${queryString({ profile: q.profile })}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holder }),
      });
    },
    getAttestations(project, q) {
      return json(`${attestationsPath(project)}?${queryString({ profile: q.profile })}`);
    },
    putAttestation(project, q, body) {
      return json(`${attestationsPath(project)}?${queryString({ profile: q.profile })}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async deleteAttestation(project, q, spec) {
      await request(`${attestationsPath(project)}?${queryString({ profile: q.profile })}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
    },
    getAuditDismissals(project) {
      return json(auditDismissalsPath(project));
    },
    putAuditDismissal(project, body) {
      return json(auditDismissalsPath(project), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async deleteAuditDismissal(project, spec) {
      await request(auditDismissalsPath(project), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
    },
    getAuditNeed(project, q) {
      return json(
        `/api/v1/projects/${encodeURIComponent(project)}/audit-needed?${queryString({ profile: q.profile })}`,
      );
    },
    getDriftLedger(project) {
      return json(`/api/v1/projects/${encodeURIComponent(project)}/drift`);
    },
    recordDeploy(project, profile, body) {
      return json(`${deploysPath(project)}?${queryString({ profile })}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    getDeployLog(project, q) {
      return json(`${deploysPath(project)}?${queryString({ profile: q.profile, limit: q.limit })}`);
    },

    recordSpend(project, body) {
      return json(spendPath(project), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    getSpend(project, q = {}) {
      return json(`${spendPath(project)}?${queryString({ since: q.since, until: q.until })}`);
    },

    async listProjects() {
      const { projects } = await json<{ projects: string[] }>("/api/v1/projects");
      return projects;
    },

    putSession(project, profile, name, storageState) {
      return putJson(`${scopePath(project, "sessions", profile)}/${encodeURIComponent(name)}`, storageState);
    },
    getSession(project, profile, name) {
      return json(`${scopePath(project, "sessions", profile)}/${encodeURIComponent(name)}`);
    },
    async listSessions(project, profile) {
      const { sessions } = await json<{ sessions: { name: string; updatedAt: string }[] }>(
        scopePath(project, "sessions", profile),
      );
      return sessions;
    },
    deleteSession(project, profile, name) {
      return noBody(`${scopePath(project, "sessions", profile)}/${encodeURIComponent(name)}`, "DELETE");
    },

    putVariable(project, profile, name, v) {
      return putJson(`${scopePath(project, "variables", profile)}/${encodeURIComponent(name)}`, v);
    },
    async listVariables(project, profile, opts = {}) {
      const query = opts.includeValues ? "?include=values" : "";
      const { variables } = await json<{ variables: HubVariable[] }>(
        `${scopePath(project, "variables", profile)}${query}`,
      );
      return variables;
    },
    deleteVariable(project, profile, name) {
      return noBody(`${scopePath(project, "variables", profile)}/${encodeURIComponent(name)}`, "DELETE");
    },

    putPrompt(project, name, body) {
      return request(`${promptsPath(project)}/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
        body,
      }).then(() => undefined);
    },
    async getPrompt(project, name) {
      try {
        return await text(`${promptsPath(project)}/${encodeURIComponent(name)}`);
      } catch (err) {
        if (err instanceof HubApiError && err.status === 404) return null;
        throw err;
      }
    },
    async listPrompts(project) {
      const { prompts } = await json<{ prompts: HubPromptMeta[] }>(promptsPath(project));
      return prompts;
    },
    deletePrompt(project, name) {
      return noBody(`${promptsPath(project)}/${encodeURIComponent(name)}`, "DELETE");
    },

    putPerspectives(project, doc) {
      return putJson(perspectivesPath(project), doc);
    },
    patchPerspectivesNote(project, c) {
      return request(perspectivesPath(project), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(c),
      }).then(() => undefined);
    },
    async getPerspectives(project) {
      try {
        return await json<unknown>(perspectivesPath(project));
      } catch (err) {
        if (err instanceof HubApiError && err.status === 404) return null;
        throw err;
      }
    },
    deletePerspectives(project) {
      return noBody(perspectivesPath(project), "DELETE");
    },
  };
}

/** `/api/v1/projects/<project>/<kind>/<profile>` — the scope prefix secret endpoints share. */
function scopePath(project: string, kind: "sessions" | "variables", profile: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/${kind}/${encodeURIComponent(profile)}`;
}

/** Prompts are project-scoped (not per-profile): `/api/v1/projects/<project>/prompts`. */
function promptsPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/prompts`;
}

/** The deploy log is per project, selected by a `?profile=` query param: `/api/v1/projects/<project>/deploys`. */
function deploysPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/deploys`;
}

function spendPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/spend`;
}

function locksPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/locks`;
}

function attestationsPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/attestations`;
}

function auditDismissalsPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/audit-dismissals`;
}

/** Perspectives are one document per project: `/api/v1/projects/<project>/perspectives`. */
function perspectivesPath(project: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/perspectives`;
}

/** `/api/v1/projects/<project>/sourcemaps/<commit>` — the scope a push and a read share. */
function sourceMapPath(project: string, commit: string): string {
  return `/api/v1/projects/${encodeURIComponent(project)}/sourcemaps/${encodeURIComponent(commit)}`;
}

/**
 * Asset paths keep their separators — the route matches the rest of the URL as
 * one wildcard segment — so only the parts between them are escaped.
 */
function encodeAssetPath(assetPath: string): string {
  return assetPath.split("/").map(encodeURIComponent).join("/");
}

function queryString(params: Record<string, string | number | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out.set(key, String(value));
  }
  return out;
}

/**
 * `Uint8Array` isn't a valid `BodyInit` in every fetch implementation's
 * types (browser lib.dom vs Node's undici disagree) — go through a plain
 * `ArrayBuffer` slice, which every implementation accepts.
 */
function toBodyInit(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
