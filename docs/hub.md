# Hub

`ccqa run` is the execution engine; it works standalone on a laptop or in CI
with no server involved, and that is unchanged. `ccqa serve` — the **hub** —
is a thin control plane on top: a small HTTP server that stores the results
of runs that already happened elsewhere, plus the sessions, variables, and
triage records a team wants to share. The hub never executes `ccqa run`
itself and has no notion of a "queue" — every run it knows about was already
finished before it was pushed.

This document is the operator's guide: how to start a hub, push finished
runs to it, and manage the sessions/variables/prompts `ccqa run` and
`ccqa record` fetch from it directly at run time. For the wire format
itself — every endpoint, request/response shape, and the TypeScript
client — see [`docs/hub-api.md`](./hub-api.md).

## Starting a hub

```bash
export CCQA_HUB_TOKEN=<token>              # required — bearer token for every request
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)  # optional — see Encryption below
ccqa serve
```

`CCQA_HUB_TOKEN` is required; without it `ccqa serve` exits 2 with
"`CCQA_HUB_TOKEN is required (the hub's bearer token — pick any non-guessable secret)`".
`CCQA_HUB_ENCRYPTION_KEY` is optional — omitting it only disables session/variable
storage (a warning is logged, and `PUT` on either endpoint returns `503`); the hub
still starts and serves runs.

Flags:

```bash
ccqa serve --port 8787                  # TCP port to listen on. Default 8787.
ccqa serve --data-dir ./ccqa-hub-data   # Runs, sessions, variables. Default ./ccqa-hub-data.
ccqa serve --allow-origin https://intranet.example  # CORS-allowed origin, repeatable. Omit for no cross-origin access.
ccqa serve --max-push-mb 32             # Reject pushed report bundles larger than this (MB). Default 32.
```

On startup the hub logs its port, data directory, whether encryption is
enabled, the allowed CORS origins (if any), and the URL it's listening at.

## How runs, sessions, and variables flow through the hub

Runs and secrets take two independent, one-directional paths:

```
ccqa run --report ──► ccqa hub push ──► hub   (stores as an immutable Run)

ccqa hub session push / var set ──► hub ──► ccqa run / ccqa record (fetched at run time)
```

`ccqa hub push` never triggers a run, and fetching sessions/variables/prompts
never uploads a result — the only thing that connects the two directions is
that a CI job typically runs `ccqa run --report` (which fetches what it needs
from the hub as it goes) then `ccqa hub push` in sequence, all authenticated
with the same `CCQA_HUB_TOKEN`.

### Projects

One hub manages many projects — one per consuming `.ccqa` tree. Runs are
labeled with a project, and sessions/variables are stored per
project/profile (e.g. project `webapp`, profile `staging`). Projects are
implicit: pushing a run or storing a secret under a name creates it, and it
disappears when nothing references it. Every `ccqa hub` subcommand defaults
`--project` to the current directory's basename, so pushing results and
managing secrets from the same tree land in the same project — pass
`--project` explicitly in CI to make that pairing typo-proof.

### `ccqa hub push`

```bash
ccqa hub push --project demo
```

Uploads the report directory of an already-finished `ccqa run --report` as a
tar.gz to the hub, which records it as an immutable `Run`. Flags:

- `--report <dir>` — report directory to push. Default `ccqa-report`.
- `--project <name>` — logical project name. Defaults to the current
  directory's basename.
- `--branch <name>` — branch label. Defaults to `$GITHUB_HEAD_REF`, then
  `$GITHUB_REF_NAME`, then the current git branch, then omitted if none
  resolve.
- `--hub-url` / `--hub-token` (or `CCQA_HUB_URL` / `CCQA_HUB_TOKEN`).
- `--cwd <path>` — directory the report dir is resolved against.

`push` packs the report directory (report.json + evidence PNGs) and uploads
it; the hub UI renders the results and serves each evidence image over its
API. It exits 2 if `report.json` is missing or invalid in the
report directory, with a hint to run `ccqa run --report` first — `push`
only uploads a result, it never re-runs or re-judges anything, so its exit
code reflects the upload itself, not the run's pass/fail outcome. On
success it prints the run id, project, branch, status, spec pass count, and
a link to the run in the hub's UI.

### Fetching sessions, variables, and prompts at run time

There is no `pull` command — `ccqa run` and `ccqa record` fetch what they
need from the hub directly as they execute, whenever `--hub-url`/`--hub-token`
(or `CCQA_HUB_URL`/`CCQA_HUB_TOKEN`) are set:

- A spec's `session:` restores fetch the named session(s) for the resolved
  project/profile straight from the hub.
- `--profile <name>` fetches every variable for that project/profile and
  applies them to the process environment before the run starts.
- `--update-agent-prompt` reads and writes the `record.agent` / `live.agent`
  prompt on the hub; the failure-analysis custom prompt is fetched the same
  way.

This is what lets a CI job hold exactly one secret, `CCQA_HUB_TOKEN` — no
per-session file checked in, no separate secret per variable a spec needs,
and no restore step to run before `ccqa run`.

## Sharing sessions and variables via the hub

`ccqa hub session push` and `ccqa hub var set` upload a session or
environment variable to the hub once. Nothing happens automatically after
that — a client (typically a CI job) runs `ccqa run` (or `ccqa record`),
which fetches the current values from the hub as it goes.

```bash
ccqa hub session push my-login                 # uploads .ccqa/sessions/default/my-login.json
ccqa hub session ls                             # names + last-updated times (metadata only)
ccqa hub var set BASE_URL --value https://staging.example
echo "$TOKEN" | ccqa hub var set API_TOKEN --sensitive   # value from stdin, hidden from `ls`
```

All subcommands take `--hub-url`/`--hub-token` (or `CCQA_HUB_URL`/`CCQA_HUB_TOKEN`),
`--project <name>` (defaults to the current directory's basename), and
`--profile <name>` (defaults to `default`) to pick which bucket of
sessions/variables to read or write. The hub's bundled UI has a **Secrets
tab** that does the same over the browser — list, add, and delete variables
and sessions per project/profile (sensitive values stay hidden in listings).

### GitHub Actions example

```yaml
name: ccqa
on: [pull_request]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      CCQA_HUB_URL: https://hub.example
      CCQA_HUB_TOKEN: ${{ secrets.CCQA_HUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec ccqa run --project demo --profile staging --report
      - run: pnpm exec ccqa hub push --project demo
        if: always()
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ccqa-report
          path: ccqa-report/
```

`if: always()` on the push step matters: a failing run is exactly the kind
of result a team wants recorded on the hub, not just a passing one.
`ccqa run --report`'s own failure analysis still needs `ANTHROPIC_API_KEY` /
a logged-in Claude Code session, independent of the hub — see
[Authentication in CI](./drift.md#authentication-in-ci). The hub does no
Claude-driven analysis of pushed reports (that already happened locally or in
CI). The one exception is a [triage-learning](#triage-learning) job: if you
want the hub to run those, give the hub process its own `ANTHROPIC_API_KEY` /
Claude login. The hub starts fine without any credentials — only learning
jobs fail (with a clear error) until you add one.

## The bundled UI

Browsing `http://<hub>/` opens a small built-in dashboard (no build step, no
external dependencies — it talks to the same `/api/v1` endpoints as everything
else). On first visit it shows a login screen asking for the hub token;
once you connect, the token is remembered in the browser (see the security
note below) and reconnected automatically on the next visit, so you don't
re-enter it every time. A **Disconnect** control in the top bar clears it and
returns to the login screen. After connecting, pick a project from the
sidebar's **Projects** view or the project menu in the top bar — everything
else is scoped to the selected project.

- **Projects** lists every project the hub knows about and lets you create a
  new one (projects are implicit — a new name becomes real once you store a
  run or a secret under it). Selecting one scopes the rest of the UI to it.
- **Runs** lists each pushed run for the selected project — one row per
  `ccqa run` execution, with its branch, pass/fail status, spec counts, and a link
  to the GitHub Actions run when it came from CI.
- **Run detail** IS the report — there is no separate HTML file. It shows each
  spec's pass/fail, its evidence screenshots (with before/after frames for live
  runs), the failure analysis (predicted cause, confidence, and reasoning), and
  the drift/assertion details. Evidence images are fetched through the artifacts
  API with the token in a header (never in the URL). You can grade each failed
  spec's **actual cause** right here — the grade is saved to the hub (not just
  your browser) and a confusion matrix of predicted-vs-actual updates live. Each
  run also shows which **profile** (environment) it executed against.
- **Secrets** lists, adds, and deletes the variables and sessions for the
  selected project, per **profile** (chosen with the selector in this tab —
  profiles scope secrets only; prompts and runs are project-wide). Sensitive
  values stay hidden.
- **Prompts** shows the project's custom instructions and the learned
  failure-cause classification — project-wide, shared across profiles.
- **Learning** turns your triage grades into a better analysis custom prompt. After
  grading failing specs on a run, a **Learn from these grades** button appears
  under the confusion matrix; it starts an asynchronous learning job that has
  Claude write a calibration note. The Learning tab lists jobs and their
  status, and each job's page shows the analysis prompt **before and after**
  the learned custom prompt, side by side.

The full report bundle (report.json + evidence PNGs) is available as a tarball
download via the run detail's "Download artifacts" link.

## Triage learning

Grading a run's failing specs (predicted cause vs. the real one) builds up a
labelled history on the hub. A **learning job** has Claude turn that history
into an `analysis-custom-prompt` prompt — a short calibration note — that calibrates
future failure classification to this project's conventions. Learning runs on
the hub as an asynchronous job, triggered from the UI
(or `POST /learning-jobs`, see [the API](./hub-api.md#learning-jobs)) — it is not a CLI
command.

Learning always needs `ANTHROPIC_API_KEY` / a Claude login **on the hub
process**; the job fails with a clear error if it's missing (the hub itself
stays up).

The learned custom prompt is stored like any other prompt and fetched
directly by the next `ccqa run`, so it picks it up automatically.

## Security

Anyone holding `CCQA_HUB_TOKEN` can read stored session cookies and variable
values, not just write them — this is a deliberate tradeoff so a CI job can
hold exactly one secret instead of one per session/variable, at the cost of
that one secret being able to read everything the hub stores. Compensate by
running the hub behind a TLS reverse proxy, adding SSO/VPN in front of it,
and rotating `CCQA_HUB_TOKEN` periodically. The UI's Secrets tab is a
management surface under the same assumptions: plaintext values transit the
(TLS-protected) API. The UI stores the bearer token in the browser's
localStorage so it can reconnect without re-prompting — a deliberate
convenience trade-off that leans on the "TLS + trusted network" assumption
above and on the UI never using `innerHTML` (its XSS surface is minimal).
Plaintext secret values are never written to localStorage; only the token is,
and **Disconnect** clears it. See [Security notes in
docs/hub-api.md](./hub-api.md#security-notes) for the full picture,
including the `?token=` query-parameter tradeoff.

## Encryption

Sessions and variables are stored AES-256-GCM encrypted at rest, keyed by
`CCQA_HUB_ENCRYPTION_KEY` — a 32-byte key as 64 hex characters:

```bash
openssl rand -hex 32
```

Without this key configured, the hub still starts, but `PUT` on a session or
variable returns `503` (and a warning is logged at startup) — there is no
plaintext fallback.

## Running the hub in a container

See [`examples/hub-docker/`](../examples/hub-docker/) for a Docker Compose
setup that runs the hub in a container.
