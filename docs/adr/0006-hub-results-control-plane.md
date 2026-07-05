# 0006. Hub is a results/sessions/variables control plane, not a remote executor

- Status: accepted
- Date: 2026-07-03

## Context and problem statement

ccqa was a local CLI: every run, session, and variable lived on whichever
machine invoked it. That works for a single developer or a single CI job,
but it gives a team no shared place to trigger or aggregate runs, no way to
reuse a signed-in session or a secret across machines without re-provisioning
it everywhere, and no central store of run history and triage without git
access. An initial design closed this gap by having the hub execute runs
remotely — queueing uploaded workspace snapshots and spawning `ccqa run` as
a child process against each one, with `node_modules` symlinked in from the
hub's own install to avoid a `pnpm install` per run. That design was fully
implemented and then reconsidered — see Considered options.

## Considered options

- Hub queues and executes runs itself, spawning `ccqa run` as a child
  process (implemented, then rejected — see Decision outcome for why).
- No hub at all; push the sharing problem onto each consumer's own CI
  system entirely.
- Hub aggregates results/sessions/variables only; execution stays wherever
  it already happens, CI or a laptop (chosen).

## Decision outcome

Chosen option: "results/sessions/variables only", because owning execution
made the hub a persistently-running, GB-scale compute instance (browser
automation needs a real Chrome plus real memory/CPU) with its own capacity
and queue-management problem, when every consumer already has an execution
environment — and a billing/capacity model for it — in their CI system. That
duplicates infrastructure the consumer already pays for and operates. It
also forced a real constraint on spec code: the symlink-based dependency
injection meant a snapshot could only `import` from `ccqa/test-helpers`,
`vitest`, and `agent-browser`, never an arbitrary npm package, and the
planned `--allow-install` escape hatch never shipped.

Concretely, "control plane, not executor" means: `ccqa run` (local or CI) is
and remains the one execution engine, full stop. The hub never spawns it,
never queues it, and never holds a compute budget for it. CI already has an
execution environment and its own billing for that; the hub's job is only to
aggregate what already ran.

The hub-executes-remotely design was implemented in full before this pivot;
it is preserved on the `backup/hub-remote-execution` branch for reference,
and a possible revival — e.g. behind an opt-in flag, or once there's a
concrete need the current model can't meet — is left as a future GitHub
issue rather than resurrected inline here.

### Major design decisions

- **A pushed run is immutable and fully derived from an already-produced
  `report.json`** — no create-then-run lifecycle, no run states beyond
  `passed`/`failed`. `ccqa hub push` uploads a finished report directory;
  the hub only records it.
- **Storage still sits behind a `HubStorage` interface** — unchanged from
  the original design: one file-backed implementation ships today, and a
  future backend (SQLite, a remote DB) can implement the same sub-stores
  without touching the API layer.
- **The triage API is unchanged by this pivot** — predicted-vs-actual
  failure cause recording was already a pure data-recording feature, not an
  execution feature, so it survives as-is.
- **Sessions/variables: the write-only guarantee is explicitly withdrawn** —
  `ccqa hub pull` needs the hub to serve back plaintext (decrypted) values
  to any token holder, which is a deliberate trade for CI needing only one
  secret (`CCQA_HUB_TOKEN`). Mitigated by recommending TLS and an additional
  auth layer (SSO) in front of the hub, plus token rotation. (`pull` was
  later removed as a standalone command; `ccqa run` now fetches these
  values directly at execution time, but the plaintext-over-the-API trade
  and its mitigations described here still apply.)

### Consequences

- Good: a CI job still needs only one secret (`CCQA_HUB_TOKEN`); no
  compute/capacity/queue-management burden on the hub; no
  dependency-injection/import-surface constraint on spec code, since nothing
  runs on the hub anymore; the triage API and its storage carry over
  unchanged; the public REST API stays a thin, mostly-stateless aggregation
  layer that's easy to run anywhere — a container, a small VM.
- Bad / cost: session/variable values are now genuinely readable by any
  `CCQA_HUB_TOKEN` holder, not just write-only — mitigated but not
  eliminated by the TLS/SSO/rotation recommendations above; the hub is still
  a single shared-secret token with no user-level access control.
- Follow-up: a possible future revival of remote execution (see the backup
  branch and future-issue note above); per-client tokens or more granular
  access control; webhook notifications on push.

### Confirmation

Unit tests cover the hub API handlers and the file-backed `HubStorage`
implementation; `tests/e2e/scenarios/hub-push.test.ts` covers
`ccqa hub push` end-to-end against a running hub, including a passing run, a
failing run, and the no-report-to-push error path. `pnpm typecheck` and the
hub test suite pass.

## More information (optional)

- `src/hub/`, `src/hub-client/`, `src/cli/serve.ts`, `src/cli/hub.ts`,
  [`docs/hub-api.md`](../hub-api.md).
- The rejected remote-execution design's full implementation is preserved on
  the `backup/hub-remote-execution` branch.
