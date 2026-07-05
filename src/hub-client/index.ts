import type {
  PutActualCauseRequest,
  Run,
  RunStatus,
  RunTriage,
  TriageCase,
} from "../hub/contract/schema.ts";
import type { PromptName } from "../prompts/prompt-names.ts";
import type { LabelsExport } from "../report/schema.ts";

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

export interface HubClient {
  /** Push a report directory (as a tar.gz) for an already-finished `ccqa run`. */
  pushRun(archive: Uint8Array, meta: { project: string; branch?: string; profile?: string }): Promise<Run>;
  listRuns(q?: { project?: string; branch?: string; status?: RunStatus; limit?: number }): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  getReport(id: string): Promise<unknown>;
  downloadArtifacts(id: string): Promise<Uint8Array>;

  getTriage(id: string): Promise<RunTriage>;
  putActualCause(
    id: string,
    c: { feature: string; spec: string },
    v: PutActualCauseRequest,
  ): Promise<TriageCase>;
  deleteActualCause(id: string, c: { feature: string; spec: string }): Promise<void>;
  importActualCauses(id: string, labels: LabelsExport): Promise<{ imported: number }>;

  /** Every project the hub knows (from runs and stored secrets). */
  listProjects(): Promise<string[]>;

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

export function createHubClient(opts: HubClientOptions): HubClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

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

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const maxAttempts = RETRYABLE_METHODS.has(method) ? RETRY_BACKOFF_MS.length + 1 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Bound each attempt so a stalled/reused socket can't hang a poll loop
      // forever; a caller-supplied signal (e.g. user cancellation) wins.
      const signal = init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          ...init,
          signal,
          headers: { ...init.headers, Authorization: `Bearer ${opts.token}` },
        });
      } catch (err) {
        // Transient network/socket error (or timeout abort) — retry GET/DELETE.
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
      return json(`/api/v1/runs?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: toBodyInit(archive),
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
