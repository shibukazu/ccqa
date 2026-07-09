# 0009. A run is mutable while running, immutable once terminal

- Status: accepted
- Date: 2026-07-09

## Context and problem statement

ADR-0006 modeled a hub run as fully derived from an already-finished
`report.json`: `ccqa run` executes to completion, writes one `report.json`,
and `ccqa hub push` uploads it once as an immutable record. That model
breaks down for a long-running `ccqa run` (many live specs, each driving a
real browser) that gets interrupted — `SIGINT`, an OOM kill, or a CI job
hitting its time limit. Before this change, `report.json` was written once,
after every spec finished; an interruption lost every already-executed
spec's result, both locally and on the hub, because there was nothing to
push yet. A team running a large live suite in CI had no way to see partial
progress or recover partial results from a run that never reached its final
write.

## Considered options

- Keep the report write local-only: make `report.json` incremental
  (write-as-you-go) but still push it to the hub only once, at the end,
  from an `if: always()` CI step. Recovers the local file on interruption
  but the hub still shows nothing until — and unless — that final step
  runs.
- Push the whole report directory to the hub after every spec (repeatedly
  calling the existing immutable `POST /runs`). Gives real-time hub
  visibility but re-uploads and re-derives the entire run from scratch on
  every spec, and creates a new "run" record each time instead of one
  evolving run.
- Give a run a **mutable-while-running** state on the hub: open it once,
  patch it incrementally as each spec finishes, and seal it terminal at the
  end or on interrupt (chosen).

## Decision outcome

Chosen option: "mutable-while-running", because it is the only one that
gives both an incrementally-recoverable local report and a hub view that
updates in near-real-time as a long run progresses, without re-deriving the
whole run from scratch on every spec.

This **partially revises** ADR-0006's "a pushed run is immutable and fully
derived from an already-produced `report.json` — no create-then-run
lifecycle, no run states beyond `passed`/`failed`" clause. The revision is
narrow: a run may now pass through a `running` state before reaching
`passed`/`failed`, and while `running` it accepts incremental patches. Once
a run reaches `passed` or `failed` it is immutable again, exactly as ADR-0006
described — terminal runs are never re-opened or re-patched.

ADR-0006's actual point — **no remote execution** — is fully preserved.
The hub still has no compute budget, no queue, no browser, and never spawns
or drives `ccqa run`. `ccqa run` (local or CI) remains the one execution
engine; the hub's new role is only to accept a *stream* of results from a
run that is executing elsewhere, instead of a single upload after the fact.
This is a lifecycle change to how an already-elsewhere-executing run's
results reach the hub, not a step toward the hub executing anything itself.

### Major design decisions

- **A third run status, `running`, sits before the existing `passed` /
  `failed`.** `POST /api/v1/runs/open` creates a run in `running` status;
  `PATCH /api/v1/runs/:id` accumulates spec results and evidence into it;
  a patch with `done: true` seals it to `passed` or `failed`. The existing
  `POST /api/v1/runs` immutable single-shot push (`ccqa hub push`) is
  unchanged and still produces a terminal run directly.
- **Terminal is a one-way door.** `PATCH` on a run that is not `running`
  (already `passed`/`failed`, including one created by the immutable push
  path) returns `409`. This preserves ADR-0006's immutability guarantee for
  every run that has finished, regardless of which path created it.
- **Evidence accumulates per file, not by re-tarring.** Each `PATCH` may
  carry a map of new evidence files (relative path → base64 bytes); the hub
  writes each file individually into the run's artifact directory. A
  long run with many specs is therefore `O(number of new files)` per patch,
  not `O(total evidence so far)`.
- **Spec rows upsert by `feature/spec` key.** A `PATCH` carries the report
  rows finished since the last patch; the hub merges them into `report.json`
  keyed by `feature/spec`, so re-sending a row (e.g. the final reconcile
  patch re-sending everything for authoritative metadata) safely overwrites
  rather than duplicates.
- **The incremental push is best-effort and non-blocking.** If no hub
  credentials are configured, `ccqa run` never opens a run and behaves
  exactly as before (local report only). If a hub is configured but
  unreachable — at open time or on any per-spec patch — the failure is
  logged and the run continues; a spec's outcome is never gated on hub
  reachability, and hub calls are not retried, so a flaky patch never
  stalls execution.
- **Interruption reconciles instead of losing state.** A teardown path
  (`SIGINT`/`SIGTERM`, or normal completion) flushes the local incremental
  report and, if a run is open on the hub, sends one last patch with every
  row collected so far and `done: true, finalStatus: "failed"` — sealing
  the run to a terminal state rather than leaving it `running` forever.
- **An orphaned `running` run is reconciled at hub startup, not by a
  timeout.** If the hub process restarts while a run is still `running` —
  its own crash, a redeploy — nothing will ever resume patching it, so
  every run found in `running` status is flipped to `failed` once, at
  startup, before the hub starts serving. This is a simple sweep, not a
  polling GC loop: a run can only get stuck this way if the hub itself
  stopped mid-run, and the hub restarting is exactly the moment to notice.

### Consequences

- Good: a long, interrupted live run keeps every already-executed spec's
  result, both in the local `report.json` and on the hub, instead of losing
  everything to a single final write; a run in progress is visible on the
  hub in near-real-time instead of only after it finishes; the existing
  single-shot `ccqa hub push` path is untouched for callers that don't need
  incremental visibility.
- Bad / cost: a `ccqa run` against a hub now makes one HTTP request per
  finished spec instead of one for the whole run, so request volume scales
  with spec count; the hub gained a small amount of lifecycle state (the
  `running` status and its startup sweep) that ADR-0006 had deliberately
  avoided; a hub that is down for the entire duration of a run silently
  produces no hub-side record of that run at all (the local report is
  still complete).
- Follow-up: none identified yet; a future incremental push for
  deterministic (non-live) specs is possible but out of scope here — see
  More information.

### Confirmation

Unit tests cover the incremental local report writer (upsert-by-key,
concurrent-write safety, best-effort sink dispatch), the hub's `open`/`patch`
handlers (accumulation, `done` sealing, `409` after terminal, per-file
evidence storage, concurrent-patch safety), the hub-client's `openRun`/
`patchRun` methods (correct routes, no retry), the startup sweep that flips
an orphaned `running` run to `failed` across a hub restart, and the teardown
registry (finalizers run before session reap, a throwing finalizer still
reaps, idempotent on a double signal). An end-to-end scenario exercises a
full incremental run against a live hub, including the no-hub-credentials and
hub-unreachable fallback paths. `pnpm typecheck` and the full test suite pass.

## More information (optional)

- ADR-0006 (`0006-hub-results-control-plane.md`) — the immutability/
  lifecycle clause this ADR partially supersedes; ADR-0006's
  no-remote-execution decision is unaffected and remains in force.
- `src/hub/api/handlers/runs.ts`, `src/hub/api/server.ts` (routes and the
  startup sweep), `src/hub/contract/schema.ts` (the `running` status),
  `src/hub/core/storage/file/` (per-file evidence storage, atomic writes).
- `src/run/incremental-report.ts` (local incremental report writer),
  `src/cli/run-teardown.ts` (signal handling and finalizers),
  `src/run/pipeline.ts` (wiring the local writer to the hub sink).
- `docs/hub-api.md`, `docs/hub.md` — the updated operator-facing surface.

## Update (2026-07-09)

The trigger for incremental push was changed from implicit (any hub
credentials present during `ccqa run`) to explicit opt-in via a new
`--push-report` flag on `ccqa run`, mirroring the existing `ccqa drift
--push`. Without `--push-report`, hub connection info passed to `ccqa run`
(`--hub-url`/`--hub-token` or `CCQA_HUB_URL`/`CCQA_HUB_TOKEN`) is used only
to fetch sessions/variables/prompts at run time, as described above — it no
longer opens or patches a run on the hub by itself. The rest of this ADR's
design (the `running` status, per-spec patching, terminal-is-one-way-door,
the teardown/reconcile path, the startup sweep) is unchanged; only the
condition that switches it on moved from "hub credentials configured" to
"`--push-report` passed".
