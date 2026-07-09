# Hub API

`ccqa serve` exposes a REST API under `/api/v1`. This is a **public contract**,
not an internal implementation detail: the ccqa CLI (`ccqa hub push`, and
`ccqa run`/`ccqa record` fetching sessions/variables/prompts at run time),
the hub's own bundled WebUI, and any other HTTP client (an intranet web app,
a script) all consume the exact same endpoints. The bundled UI has no
privileged access this API doesn't also grant everyone else — see
[`docs/hub.md`](./hub.md) for the architecture that guarantees this.

A typed TypeScript client is published at `ccqa/hub-client` (see
[TypeScript client](#typescript-client) below); this document is the
contract it wraps, for any other language or environment.

## Authentication

Every endpoint except `GET /api/v1/health` and `GET /` requires a bearer
token, set on the hub via the `CCQA_HUB_TOKEN` environment variable:

```
Authorization: Bearer <token>
```

Read-only `GET` endpoints (`artifacts/*`) additionally accept the token as a
`?token=` query parameter, since a browser `<a>` tag (the artifacts download)
can't set headers. This risks the token leaking via `Referer`, browser
history, or proxy logs — see [Security notes](#security-notes) for the full
tradeoff.

## Errors

Non-2xx responses are always:

```json
{ "error": { "code": "not_found", "message": "run \"abc\" not found" } }
```

## Runs

The hub never executes anything — a run is created when a client pushes the
report directory of an already-finished `ccqa run --report` as a gzip tar
archive. Every field of the resulting `Run` is derived server-side from that
report; a run is immutable once created (there is no update/patch).

```
POST /api/v1/runs?project=<name>&branch=<branch>&profile=<profile>&kind=<kind>
  Content-Type: application/gzip
  body: gzip tar of a `ccqa run --report` output directory (must contain report.json)
  ?profile is optional — recorded on the Run for display; runs are not scoped by profile
  ?kind is optional — "run" (default) or "drift"; "drift" is a `ccqa drift --push` audit, not an executed run
  → 201 Run

GET /api/v1/runs?project=<name>&branch=<branch>&status=<status>&limit=<n>
  → 200 { runs: Run[] }

GET /api/v1/runs/:id
  → 200 Run | 404

GET /api/v1/runs/:id/report
  → 200 RunReportData (report.json bytes, unmodified) | 404

GET /api/v1/runs/:id/artifacts
  → 200 application/gzip (tarball of the run's full report directory) | 404

GET /api/v1/runs/:id/artifacts/*path
  → 200 (individual file — the hub UI fetches evidence PNGs this way) | 404
```

As an alternative to the single-shot push above, a still-executing
`ccqa run` can stream results into the hub incrementally, spec by spec,
instead of waiting until it finishes:

```
POST /api/v1/runs/open?project=<name>&branch=<branch>&profile=<profile>&kind=<kind>
  (same query params as POST /api/v1/runs, no body)
  → 201 Run   (status: "running")

PATCH /api/v1/runs/:id
  Content-Type: application/json
  body: {
    rows: ReportSpecResult[],
    evidence?: Record<string, string>,  // relative path -> base64 file bytes
    done?: boolean,
    finalStatus?: "passed" | "failed",
    reportMeta?: Partial<ReportEnvelope>,
  }
  → 200 Run | 404 (no such run) | 409 (run is not currently "running")
  Spec rows upsert into report.json's `results`, keyed by feature/spec — safe
  to resend the same row. Evidence files are written individually, not as a
  re-upload of the whole tarball. `done: true` seals the run to `finalStatus`
  if given, else `specs.failed > 0 ? "failed" : "passed"`.
```

```ts
interface Run {
  id: string;
  project: string;
  profile: string | null;    // which profile/environment the run executed against; display-only
  branch: string | null;
  status: "passed" | "failed" | "running";
  kind: "run" | "drift";     // "run" = ccqa run/live execution; "drift" = ccqa drift --push
  drift: { issues: number; errors: number; warnings: number; specsWithIssues: number } | null; // set only for kind: "drift"
  specs: { total: number; passed: number; failed: number };
  gitHead: string | null;
  promptVersion: string;
  ciRunId: string | null;    // from the report, e.g. GITHUB_RUN_ID; null when run locally
  reportCreatedAt: string;   // when the underlying `ccqa run` actually executed
  createdAt: string;         // when the hub accepted the push
}
```

`branch` defaults from the pushing client (`ccqa hub push` / `ccqa drift --push`
resolve `$GITHUB_HEAD_REF` → `$GITHUB_REF_NAME` → the local git branch), and is
`null` if the client sent none. `status` is `"passed"`, `"failed"`, or
`"running"` — `running` never means the hub itself is executing anything;
it only means a `ccqa run` elsewhere is currently streaming results into
this run record via `POST /api/v1/runs/open` and `PATCH /api/v1/runs/:id`.
`drift` is derived from the pushed report's `results[].driftIssues` and is
`null` for `kind: "run"`.

A run opened via `POST /api/v1/runs/open` accepts repeated `PATCH` calls
while it's `running`: each one upserts spec rows (by feature/spec) and adds
evidence files incrementally. A `PATCH` with `done: true` seals the run to
`passed`/`failed`; any `PATCH` after that returns `409`, matching the
existing rule that a terminal run is immutable. If the hub process itself
restarts while a run is still `running` (e.g. it crashed or was redeployed
mid-run), a one-time startup sweep flips every such orphaned run to
`"failed"`, since nothing will ever resume patching it.

## Triage

Each failing spec's classification pairs an AI **prediction** (read-only,
sourced from the run's report) with a human-recorded **actual cause**
(write-only from the client's perspective). See
[`docs/report.md`](./report.md) for what TEST_DRIFT / SPEC_CHANGE /
PRODUCT_BUG mean.

```
GET /api/v1/runs/:id/triage
  → 200 {
      runId, promptVersion,
      cases: [{ feature, spec,
                predicted: { label, confidence, subDiagnosis?, headline },
                actual: { cause, note?, recordedAt } | null }],
      recorded: number, total: number   // progress readout
    }

PUT /api/v1/runs/:id/triage/:feature/:spec/actual-cause
  body: { cause: "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG", note?: string }
  → 200 TriageCase | 404 (no such case) | 409 (run has no report yet)

DELETE /api/v1/runs/:id/triage/:feature/:spec/actual-cause
  → 204

PUT /api/v1/runs/:id/triage/actual-causes
  body: LabelsExport JSON
  → 200 { imported: number }
  Bulk-import path for a batch of graded actual-causes (e.g. from external tooling).
```

## Projects

One hub manages many projects (one per consuming `.ccqa` tree). Projects are
implicit — pushing a run or storing a secret under a name creates it; when
nothing references the name anymore it disappears. Runs take the project as
an optional `?project=` **filter**; sessions and variables take it as a
required **path segment**, because a secret always belongs to exactly one
project.

```
GET /api/v1/projects
  → 200 { projects: string[] }   (distinct names across runs, sessions, variables, and prompts)

GET /api/v1/projects/:project/profiles
  → 200 { profiles: string[] }   (distinct profiles across the project's sessions + variables;
                                   "default" always included. Prompts/runs are not profile-scoped.)
```

## Sessions

Saved browser sessions (agent-browser storage state), scoped by
project/profile. `GET .../sessions/:profile/:name` is a **real read** — it
returns the decrypted session contents, not metadata. Any holder of
`CCQA_HUB_TOKEN` can call it, which is exactly what `ccqa run`/`ccqa record`
rely on to fetch a session directly at run time. See [Security notes](#security-notes).

```
PUT /api/v1/projects/:project/sessions/:profile/:name
  Content-Type: application/json
  body: raw agent-browser storage-state JSON
  → 204 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

GET /api/v1/projects/:project/sessions/:profile
  → 200 { sessions: [{ name, updatedAt }] }   (metadata only)

GET /api/v1/projects/:project/sessions/:profile/:name
  → 200 (decrypted storage-state JSON) | 404 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured)

DELETE /api/v1/projects/:project/sessions/:profile/:name
  → 204
```

## Variables

Environment variables fetched directly into a run via `--profile`, scoped
by project/profile. Non-sensitive values are always readable back (useful
for a dashboard to display current config). `sensitive: true` values are
hidden from the plain listing, but **not** from `?include=values` — that
query param is a real read of every value, sensitive or not, and is what
`--profile` resolution uses.

```
PUT /api/v1/projects/:project/variables/:profile/:name
  body: { value: string, sensitive: boolean }
  → 204 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

GET /api/v1/projects/:project/variables/:profile
  → 200 { variables: [{ name, sensitive, updatedAt, value? }] }
  `value` is present only when sensitive is false.

GET /api/v1/projects/:project/variables/:profile?include=values
  → 200 { variables: [{ name, sensitive, updatedAt, value }] }
  `value` is present for every variable, including sensitive ones.
  → 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

DELETE /api/v1/projects/:project/variables/:profile/:name
  → 204
```

Sessions and variables both require `CCQA_HUB_ENCRYPTION_KEY` to be
configured on the hub (they're stored AES-256-GCM encrypted at rest) — `PUT`,
and any `GET` that returns a decrypted value, return `503` otherwise.

## Prompts

Prompt assets (record/live guidance prompts and the analysis custom prompt), scoped
by **project only** — unlike sessions and variables, prompts are project-wide,
not per-profile (the same guidance applies across every profile a project runs
against). Prompts are **not encrypted** and require no
`CCQA_HUB_ENCRYPTION_KEY` — they are plain text, not secrets. `name` must be
one of the reserved prompt names — `record.user`, `record.agent`, `live.user`,
`live.agent`, or `analysis-custom-prompt` — anything else is `400`.

```
PUT /api/v1/projects/:project/prompts/:name
  Content-Type: text/markdown or application/json (name-dependent)
  body: prompt text (Markdown for guidance names, JSON for analysis-custom-prompt)
  → 204 | 400 (unknown prompt name)

GET /api/v1/projects/:project/prompts
  → 200 { prompts: [{ name, kind, updatedAt, meta }] }   (metadata only)

GET /api/v1/projects/:project/prompts/:name
  → 200 (raw prompt body, text/markdown or application/json) | 404

DELETE /api/v1/projects/:project/prompts/:name
  → 204
```

## Learning jobs

Turn graded triage into an improved analysis custom prompt. A job scans a project's
recent runs, collects the human-recorded actual causes, and writes a new
`analysis-custom-prompt` prompt (see [Prompts](#prompts)). Jobs are scoped by
project/profile and run asynchronously on the hub, one at a time.

Learning always has Claude write a short prose calibration note from the
graded cases. This needs Claude auth on the hub (`ANTHROPIC_API_KEY` or a
logged-in Claude Code session); without it, the job fails with a clear error
(the hub stays up).

```
POST /api/v1/projects/:project/learning-jobs
  Content-Type: application/json
  body: { profile: string, runLimit?: number }
  → 202 { ...job }   (status "queued"; poll the detail endpoint for progress)

GET /api/v1/projects/:project/learning-jobs?profile=<name>
  → 200 { jobs: [{ id, status, input, createdAt, customPromptVersion, ... }] }
    (newest first; before/after prompt bodies omitted)

GET /api/v1/projects/:project/learning-jobs/:jobId
  → 200 { id, status, input, error, result: { customPromptVersion, beforePrompt,
          afterPrompt } | null, ... } | 404
```

`status` is `queued` → `running` → `succeeded` | `failed`. On success,
`result` carries the fully-rendered analysis prompt before and after the new
custom prompt, for side-by-side review. On failure (no graded cases, no Claude auth
on the hub, or an empty calibration note), `error` explains why.

## Health

```
GET /api/v1/health   (no auth required)
  → 200 { status: "ok", version: 1, queueDepth: <learning jobs waiting> }
```

## CORS

For browser clients on a different origin (an intranet dashboard), start
the hub with `--allow-origin <origin>` (repeatable). Unlisted origins get no
CORS headers and the browser blocks the response.

## TypeScript client

```ts
import { createHubClient } from "ccqa/hub-client";

const hub = createHubClient({ baseUrl: "https://hub.example", token: "<token>" });

// Push a finished report as a run (packDirToTarGz is the same helper
// `ccqa hub push` uses internally, exported from ccqa's own source tree —
// most clients build the gzip archive with any tar library instead).
const archive = await packDirToTarGz("./ccqa-report");
const run = await hub.pushRun(archive, { project: "demo", branch: "main" });

// Fetch a session and every variable (including sensitive ones).
const session = await hub.getSession("demo", "staging", "my-login");
const variables = await hub.listVariables("demo", "staging", { includeValues: true });
```

Full method list:

```ts
pushRun(archive: Uint8Array, meta: { project: string; branch?: string }): Promise<Run>
openRun(meta: { project: string; branch?: string; profile?: string; kind?: "run" | "drift" }): Promise<Run>
patchRun(id, body: PatchRunRequest): Promise<Run>
listRuns(q?: { project?; branch?; status?; limit? }): Promise<Run[]>
getRun(id): Promise<Run>
getReport(id): Promise<unknown>
downloadArtifacts(id): Promise<Uint8Array>

listProjects(): Promise<string[]>

getTriage(id): Promise<RunTriage>
putActualCause(id, { feature, spec }, { cause, note? }): Promise<TriageCase>
deleteActualCause(id, { feature, spec }): Promise<void>
importActualCauses(id, labelsExportJson): Promise<{ imported: number }>

putSession(project, profile, name, storageState): Promise<void>
getSession(project, profile, name): Promise<unknown>
listSessions(project, profile): Promise<{ name, updatedAt }[]>
deleteSession(project, profile, name): Promise<void>

putVariable(project, profile, name, { value, sensitive }): Promise<void>
listVariables(project, profile, opts?: { includeValues? }): Promise<HubVariable[]>
deleteVariable(project, profile, name): Promise<void>

putPrompt(project, profile, name, body): Promise<void>
getPrompt(project, profile, name): Promise<string | null>
listPrompts(project, profile): Promise<HubPromptMeta[]>
deletePrompt(project, profile, name): Promise<void>
```

`createHubClient` uses the global `fetch` only (no Node-specific imports),
so it works unmodified in a browser bundle or a Node script alike.

## Security notes

- Read access is real: any holder of `CCQA_HUB_TOKEN` can read stored
  session contents (`GET .../sessions/:profile/:name`) and every variable
  value (`GET .../variables/:profile?include=values`), not just write them.
  This is required for `ccqa run` to fetch plaintext values at run time — the
  hub trades a "write-only secrets" guarantee for letting a CI job hold
  exactly one secret instead of one per session/variable.
- The hub is a single shared-secret token, not per-client credentials — treat
  it like an admin password. There's no user-level access control.
- Run it behind a reverse proxy with TLS and, for anything beyond a trusted
  LAN, an additional auth layer (SSO, VPN) — the bearer token alone is not
  meant to be internet-facing.
- A token embedded in a `?token=` URL (browser `<img>`/`<a>` tags) can leak
  through browser history or proxy access logs. Keep the hub's audience
  small and rotate `CCQA_HUB_TOKEN` periodically, and immediately if you
  suspect exposure.
- The bundled UI's Secrets tab sends plaintext values over this same API —
  it's a management surface for a trusted, TLS-protected environment, not
  for the open internet. The UI persists the bearer token in the browser's
  localStorage (so it reconnects without re-prompting) and clears it on
  "Disconnect"; it never writes plaintext secret values there. This convenience
  leans on the trusted-network assumption and on the UI never using
  `innerHTML` — keep the hub behind TLS/SSO/VPN accordingly.
