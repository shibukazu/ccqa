# 0027. A row is placed against the deploy log by its own window

- Status: accepted
- Date: 2026-09-02

## Context and problem statement

A run is stamped with the deploy-log head when it opens, and marked
`deployedShaAmbiguous` at the seal if the head moved underneath it
(ADR-0010). The stamp is run-wide: every spec's ledger entry gets the same
pair, so one deploy landing anywhere inside the run voids the whole run's
verification. Re-run selection then reports every spec as `stale`.

That is correct — a run that spans a deploy cannot say which commit it
exercised — but the blast radius is the entire run, and the run is long. A
cycle here takes about twenty minutes; the environment it tests is deployed
on merge, several times an hour in a busy stretch. A deploy at minute
nineteen discards the nineteen minutes that ran clear of it along with the
one spec that did not.

The failure mode is not lost work but **no progress**: while merges keep
arriving faster than a run completes, every run is voided, so nothing ever
verifies. The suite reports "needs re-run" forever and the verdict never
advances. Waiting for a quiet window is the only way out, and nothing
guarantees one arrives.

## Considered options

- **Defer recording deploys while a run is in flight.** Makes runs count by
  hiding the straddle. The run really did exercise two commits; crediting it
  with either is a false statement in the ledger, which is the one place that
  must not lie.
- **Shorten the run.** Reduces the odds without changing them qualitatively;
  a long spec still loses its siblings, and the deadlock returns whenever
  deploys outpace whatever the run time becomes.
- **Place each row by its own execution window.** A spec's window is a
  fraction of the run's, so a deploy voids the specs it actually overlapped
  and no others.

## Decision outcome

Each row carries `startedAt` and `finishedAt` — wall-clock bounds of its own
execution — and the ledger places the row against the deploy log by that
window. A row is ambiguous when the head differs at the two ends of *its*
window, and carries the head at its start otherwise.

The bounds are wall clock, not `durationMs`: that field's clock differs by
execution path (a vitest row sums assertion durations, so it excludes the
process's own startup), and a window short of the real work would slide past
a deploy the spec did straddle.

Consequences:

- **Verification progresses under continuous deploys.** A run that straddles
  a deploy still credits every spec that ran clear of it, so each cycle
  advances most of the suite instead of none of it. The deadlock is gone, not
  merely less likely.
- **The strict reading is unchanged.** A spec whose own window contains the
  move is still `stale`, never credited to either commit. Nothing is deleted:
  the result stays readable, only its currency is void (ADR-0014).
- **The window is a bound, not a measurement.** It is widened on both ends by
  a skew margin, its start is exclusive, and a row with no finish is measured
  to the seal. Each choice can cost a spec its credit; none can credit a spec
  that straddled. The runner stamps the window and the hub stamps the deploy,
  so the margin is also what a disagreeing clock spends.
- **Correct under parallelism.** The window comes from the row, not from when
  its patch arrived, so `--concurrency > 1` and the browser/live split place
  the same way as a serial run.
- **Older rows keep the old placement.** A row without `startedAt`, and any
  run whose sha the client asserted rather than the hub observing it, falls
  back to the run-wide pair. The client's claim about its own run stays the
  client's to make.
