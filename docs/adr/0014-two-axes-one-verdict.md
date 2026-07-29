# 0014. Two axes, one verdict; work in flight is a claim, not a state

- Status: accepted
- Date: 2026-07-30

## Context and problem statement

ADR-0010 gave each spec one state — `needed` / `notNeeded` / `unknown` /
`neverRun` / `notEvaluated` — and 1.15 added `blocked` for a spec the audit had
rejected. One value was answering two questions, and the collapse lost the
cases that matter most.

A spec whose last run **failed** read as `notNeeded`: the ledger's re-run
baseline is the last *execution*, and a red result is as current as a green
one. So a permanently failing spec sat in the same bucket as a spec nobody
needed to touch. A release gate reading "nothing needs a re-run" would pass
over it.

A spec the audit had **not looked at since the deploy** read as `needed` and
ran. The drift ledger records the commit each audit read, but nothing compared
it against what was deployed, so a clean verdict about older code was treated
as a clean verdict about the code running now. That is the failure the audit
exists to prevent, reintroduced one layer down.

And there was no way to say "a job is working on this right now". A run takes
15–30 minutes; the cycle that starts it is shorter than that. Two cycles reach
the same spec, two audits write the same ledger entry, two runs drive the same
browser flow — and for a spec that posts to an external service, they
interfere.

## Considered options

- **Keep one state and add values.** `blocked` was already this. Each new value
  is a new pair of things being conflated somewhere else, and the enum stops
  being a partition of anything.
- **Two axes, one derived verdict.** What the audit says, how the last run
  ended, and an answer computed from both.
- **Put "running" on the execution axis.** One more enum value, no new
  concepts.

## Decision outcome

**Two axes, one derived verdict**, with work in flight as a separate claim.

### The axes

**Audit** — `due` / `clean` / `drifted` / `undecided` / `cannotTell`. Relative
to what is *deployed*, not to whatever commit the audit happened to read: an
audit older than a deploy that reached this spec has not spoken about the code
running now, so it reads `due` until it runs again. A spec never audited is the
same answer, because to a reader asking about the deployed code it is.

**Execution** — `passed` / `failed` / `neverRun`. Deliberately no "stale pass":
*which* deploy a run covered is a separate fact the ledger already carries
(`lastRun.deployedSha`). Collapsing the two is what left the old single-axis
state unable to tell a red spec from an up-to-date one.

Neither axis determines the other. A spec can be clean and out of date, or
drifted and freshly run, and all four combinations occur.

### The verdict

Derived, evaluated in order, and named for **who acts next** — because that is
what a reader scanning a list of specs is looking for:

| Verdict | From |
| --- | --- |
| `inProgress` | a claim is held, or the audit is `due` |
| `needsRepair` | audit `drifted` or `undecided`, or execution `failed` |
| `rerunNeeded` | cleared, and the last result does not cover this deploy |
| `verified` | cleared, and it does |
| `unanswerable` | the deploy log cannot place the audit or the run |

Exactly one value, `needsRepair`, asks for a person. Two behaviours follow that
1.15 did not have: a **failed** spec is not offered for a re-run (repeating it
teaches nothing until the code moves or the spec is fixed, and a live spec
costs dollars a go), and a spec that has **never run** is `rerunNeeded` by
default (no result at all is as uncovered as a result a deploy invalidated).

An empty selection with any of `inProgress` or `unanswerable` outstanding
**exits non-zero**. "Nothing to run" reported as a green run is the one outcome
the whole selection path exists to prevent.

### Work in flight is a claim

A claim is not a value on either axis. The axes are derived from durable
ledgers and describe recorded facts; a claim describes work in flight, which
needs a lifetime they have no reason to carry — and it spans both jobs, so one
mechanism beats a parallel value in each enum. Keeping it out is also what lets
`due` mean one thing: an audit is *owed*, not *running*.

A claim **lapses rather than being reaped**: `expiresAt` is compared on every
read, so a job killed without releasing frees its specs by itself, with no
background sweep to write, schedule, or debug. The cost is that a dead job's
specs stay held until it passes, which is why the caller picks the TTL from how
long its own work can take. This is the one place wall-clock time is used;
ordering against deploys still goes by log position (ADR-0010).

Releases are keyed by holder, not by spec, so a late release from a job whose
claim already lapsed cannot take away the claim the next job has since
acquired.

### The audit asks the same question, and defaults the other way

`ccqa audit --only-hub-audit-needed` runs the same range arithmetic from the
drift ledger's `gitHead` instead of the last run's deployed sha, and both share
one implementation — keeping "does the audit still apply" and "does the result
still apply" as two near-copies is how they would come apart.

The two default in **opposite directions**, deliberately: an audit costs cents
where a live run costs dollars, so a hole in the deploy log is audited here and
declined there. A spec that was never audited is audited unconditionally, with
no diff consulted — there is no baseline for one to narrow away, which is how a
spec no deploy ever reached could otherwise stay un-audited forever.

## Consequences

Breaking, on the wire and in the CLI summary. `SpecRerun.state` becomes
`verdict` plus the two axes; `blocked` folds into `needsRepair`, `notNeeded`
into `verified`, `neverRun` into the execution axis, and `notEvaluated` into an
`unanswerable` reason. A client older than the hub reads every field as
`undefined`, so both selections now parse the response before trusting it and
say "this hub is older than this CLI" rather than selecting nothing.

A project that does not push audits to the hub selects nothing: every spec is
`due`, so every verdict is `inProgress`. That is intended — running a spec the
audit has not cleared is what this ADR exists to stop — and the non-zero exit
above makes it loud rather than silent. Migrating means one full
`ccqa audit --report-to-hub` sweep.

`ExecutionState` has no `running`. It would be a value the ledgers cannot
produce, and the claim covers it.

## More information

- Verdict and axes: `src/hub/contract/schema.ts`, derived in
  `src/hub/core/rerun.ts`
- Shared range arithmetic: `src/hub/core/deploy-range.ts`
- Claims: `src/hub/core/locks.ts`, `POST`/`DELETE
  /api/v1/projects/:project/locks`
- Audit selection: `src/hub/core/audit-need.ts`
- Related: ADR-0010 (the deploy log this reads, and the ledger's three
  buckets — its single-state model is superseded here), ADR-0008 (result and
  freshness as orthogonal axes, the shape this generalises), ADR-0013 (one
  verification environment)
