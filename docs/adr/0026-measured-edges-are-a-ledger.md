# 0026. Measured edges are a ledger, and an unmeasured spec runs

- Status: accepted
- Date: 2026-08-24

## Context and problem statement

Selection from measured reach (ADR-0024) read its edges from wherever runs
happened to leave them: the coverage event stream and pushed run reports.
Both are records of *runs*, so reading "every spec's latest reach" meant
walking runs — several round trips, bounded probes — and both age out with
the runs themselves. That forced two pieces of machinery that exist only to
fight the storage shape:

- **A freshness window.** The stream retains fourteen days, so an edge older
  than that silently vanished; selection mirrored the retention as an expiry
  and degraded old edges to `unknown`.
- **A re-measurement scheduler.** `unknown` marks nothing due (ADR-0023), so
  an expired edge could settle into a state where no run ever fires again.
  `--measure-backfill <n>` appended specs nearing expiry to keep the suite
  inside the window.

Neither concept is about selection. A measurement does not become wrong with
age — it becomes wrong when the application changes, and the deploy diff
already captures exactly that. The expiry and the backfill were compensating
for reading edges out of run-shaped storage, and they cost real complexity:
an implicit fourteen-day contract, a flag with a tuning knob, and a failure
mode ("suite silently expires") that needed its own documentation.

The same reading also conflated two states that deserve opposite verdicts:
"this spec was never measured" and "the hub could not answer". Both surfaced
as an absent edge.

## Considered options

- **Keep run-shaped storage**, add a scheduled full re-measurement run.
- **A durable edge ledger on the hub**: one document per project, one entry
  per spec, replaced when the spec runs measured, never expiring.
- **Ledger plus a periodic "sweeper" run** that re-measures everything.

## Decision outcome

Chosen option: a durable edge ledger, with no sweeper and no expiry.

The hub keeps one document per project (`coverage-edges`): per spec, the
files its most recent measured execution reached and when. Every measured
run merges what it measured at the end — the hub-inbox mode from the
stream's resolve, the local mode from the report rows — through a serialized
read-modify-write, so a run's entries land without deleting anyone else's.
Selection reads the whole answer in one GET.

Two gates guard the merge, both because entries never expire. Only a run
that already delivers to the hub writes — `--coverage-inbox hub`, or local
mode under `--report-to-hub` — so ambient hub credentials alone cannot let a
stray local run replace the project's measured edges with its own partial
tree. And a run whose application half never reported records nothing: its
rows hold only the browser's reach, and merging them would shadow a fuller
earlier measurement for good.

With edges durable, the two compensating mechanisms fall away, and the
absent-edge conflation is split into verdicts that state what is actually
known:

- **Never measured → `needed`.** The spec runs until a measurement records
  its reach. This is self-seeding: a new spec, a new project, or a spec
  whose measurement never landed all run — and running measured is precisely
  what creates the edge. No explicit seeding step, no scheduler.
- **Could not read → `unknown`.** A hub hiccup must not masquerade as
  absence, or every hiccup stampedes the whole suite into a run. A degraded
  read leaves undecided specs `unknown`, ADR-0023's vocabulary for "the
  question was not answered".

The stream and report rows remain as read sources so a hub predating the
ledger endpoint, or data measured before this change, still answers; per
spec the newest measurement wins across sources. `--measure-backfill` is
removed, not deprecated — it shipped and was replaced within the same
release cycle, and keeping a flag whose premise (expiry) no longer exists
would preserve the complexity this record deletes.

This amends ADR-0024's staleness consequence: edges no longer age out, so
"stale edge degrades to `unknown`" is retired. ADR-0023 is narrowed, not
touched: `unknown` still marks nothing due, but it now covers only the
transient can't-read state, which resolves by retry rather than by
scheduler.

### Consequences

- Good: selection is one GET over a document sized by the suite, not by run
  history; no probing runs, no retention coupling.
- Good: no implicit time contract. A spec measured once is selectable
  forever; what invalidates its verdict is a deploy that touches its reach,
  which is the event selection already watches.
- Good: cold start needs no ceremony — unmeasured specs run, runs measure,
  the ledger fills itself.
- Bad / cost: a spec whose measured runs keep failing before measurement
  lands keeps running (`needed` every deploy). That is the safe direction,
  and the run-end resolve summary names specs that measured nothing.
- Bad / cost: the ledger is another hub document with write access from
  runs; the append-only coverage token deliberately cannot write it, so
  only bearer-authenticated runs merge entries.
- Follow-up: entries carry `measuredAt` and `runId`, so a later surface can
  show ledger age and provenance without a schema change.

### Confirmation

A spec with no ledger entry, no stream resolve, and no report row selects as
`needed` with a reason naming "never measured". After one measured run, the
ledger holds its files and a diff missing them selects `notNeeded`. A
400-day-old entry still answers. With the hub unreachable mid-read, specs
the mechanical pass did not decide degrade to `unknown`, not `needed`.
