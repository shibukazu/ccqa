# 0014. Two axes, one verdict; work in flight is a claim, not a state

- Status: accepted
- Date: 2026-07-30
- Amended: 2026-07-31 — `unanswerable` removed; an unplaceable deploy range is
  assumed to have reached the spec (see "Amendment: assume reached")
- Amended: 2026-08-14 — a red retired by a lapsed attestation reads `stale`
  rather than `failed`; the verdict table below is unchanged (see ADR-0020)

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

**Audit** — `due` / `clean` / `drifted` / `undecided`. Relative to what is
*deployed*, not to whatever commit the audit happened to read: an audit older
than a deploy that reached this spec has not spoken about the code running now,
so it reads `due` until it runs again. A spec never audited is the same answer,
because to a reader asking about the deployed code it is.

**Execution** — `passed` / `failed` / `stale` / `neverRun`. `stale` is "the
run finished, but a deploy has reached this spec since": the fact existed from
the first version of this ADR — the verdict was derived from it — but it only
reached the reader as the verdict, which is why the two axes could not be read
as its inputs. `neverRun` stays distinct from `stale` even though both lead to
`rerunNeeded`: a list that merges them cannot tell a spec added yesterday from
one a deploy invalidated.

Neither axis determines the other. A spec can be clean and stale, or drifted
and freshly run, and all four combinations occur.

### The verdict

Derived and named for **who acts next** — because that is what a reader
scanning a list of specs is looking for. It is a total function of the two
axes plus whether a claim is held, with nothing else consulted:

| audit | execution | verdict |
| --- | --- | --- |
| (a claim is held) | — | `inProgress` |
| `due` | — | `inProgress` |
| `drifted` / `undecided` | — | `needsRepair` |
| `clean` | `failed` | `needsRepair` |
| `clean` | `stale` / `neverRun` | `rerunNeeded` |
| `clean` | `passed` | `verified` |

Exactly one value, `needsRepair`, asks for a person. Two behaviours follow that
1.15 did not have: a **failed** spec is not offered for a re-run (repeating it
teaches nothing until the code moves or the spec is fixed, and a live spec
costs dollars a go), and a spec that has **never run** is `rerunNeeded` by
default (no result at all is as uncovered as a result a deploy invalidated).

An empty selection with `inProgress` outstanding **exits non-zero**. "Nothing
to run" reported as a green run is the one outcome the whole selection path
exists to prevent.

### Amendment: assume reached

The first version of this ADR had a fifth verdict, `unanswerable`, for a spec
the deploy log could not place — eight distinct reasons wore it. It is gone.
**When we cannot tell whether a deploy reached a spec, we assume it did.**

Three things were wrong with it. It asked a reader to do nothing: every other
verdict names an actor, and this one named a missing input. Eight reasons wore
one face, from "no deploy log at all" to "the last run straddled a deploy" —
answers with nothing in common but the shrug. And it appeared twice on screen
with different meanings, as a verdict and as an audit state, worded identically
in both.

The spec selection stops being a hole in the ledger and becomes a filter:
present, it narrows; absent, it narrows nothing. Uncertainty turns into work
rather than into a question mark, which is the safe direction — a spec run
needlessly costs a run, a spec skipped silently costs the release. So:

- The audit's `cannotTell` folds into `due`. The audit side already audited
  when it could not tell, so *what it selects does not change* — only the name
  it reports.
- The three "we cannot place this run" reasons — `unknownDeployedSha`,
  `ambiguousDeployedSha`, `deployedShaNotInLog` — and the three range holes
  become `stale`, not `neverRun`. The result exists and is worth reading; only
  its currency is void. Nothing is deleted: `lastRun` / `lastGreen` /
  `lastRed` and the report stay.
- `--only-hub-rerun-needed-with-unknown` is removed. "Also run the ones we
  cannot answer for" is now the default, so the flag would only have meant
  "and again".

The reason survives as an **annotation**, not as a state:
`auditAssumedReached` and `executionAssumedReached` carry the same
`RerunUnknownReason` on `SpecRerun`, set only when the pending state came from
an unplaceable range rather than from an ordinary deploy touch. A reader
seeing every spec go pending must be able to find out why; what they must not
be given is a verdict that means "ask someone else".

The ADR-0010 statement that an empty selection exits non-zero still holds, and
is now satisfied differently: nothing is silently skipped, because unknowns are
included.

One vocabulary note against ADR-0010, which reserved "stale" and "fresh" from
the schema as well as from the UI: the reservation now holds for user-facing
copy only. The execution axis calls the value `stale` because that is what it
is, while the UI prints "not run since the deploy" — drift keeps the words a
reader sees.

### `deployedSha` is asserted, and it is the log head

A run sends the deploy log's head as `?deployedSha=` when it opens. The hub
prefers an asserted sha over re-reading its own log when the run finishes,
which is what makes a deploy landing mid-run harmless: the run is pinned to
the position it started from rather than becoming ambiguous.

Sending the **checkout's** sha instead was tried and reverted. It reads as the
more honest answer — in CI the checkout is the deployed commit — but a
checkout the deploy log does not contain has no position at all, so a
developer's working tree, or a CI job on a branch head newer than what
shipped, would report `stale` forever and never reach `verified`. The log head
is imprecise in a bounded way; the checkout sha is unplaceable in an unbounded
one.

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

### The audit asks the same question

`ccqa audit --only-hub-audit-needed` runs the same range arithmetic from the
drift ledger's `gitHead` instead of the last run's deployed sha, and both share
one implementation — keeping "does the audit still apply" and "does the result
still apply" as two near-copies is how they would come apart.

They used to default in opposite directions on a hole in the deploy log: an
audit costs cents where a live run costs dollars, so the audit did the work and
the run declined it. The amendment above closes that gap — both now treat an
unplaceable range as reached, and the two differ in wording rather than in what
they select. `AuditNeed.because` keeps `cannotTell` because there it is a real
explanation of why an audit is owed, not a verdict a reader has to act on.

A spec that was never audited is still audited unconditionally, with no diff
consulted — there is no baseline for one to narrow away, which is how a spec no
deploy ever reached could otherwise stay un-audited forever.

## Consequences

Breaking, on the wire and in the CLI summary. `SpecRerun.state` becomes
`verdict` plus the two axes; `blocked` folds into `needsRepair`, `notNeeded`
into `verified`, and `neverRun` into the execution axis. A client older than
the hub reads every field as `undefined`, and one newer than the hub reads a
verdict its schema rejects, so both selections parse the response before
trusting it and say "this hub is older than this CLI" rather than selecting
nothing.

The amendment's cost, stated plainly: a deploy recorded without a selection, or
one that did not chain onto its predecessor, now costs a **full audit sweep and
a full run** of every spec behind it, where it used to cost a question mark.
The audit running first does not reduce that. The two axes read the same hole
from two baselines, so the audit's own verdict comes back `due` as well — and
even once it has run and answered `clean`, the execution axis is `stale`
regardless of what it answered. A missed deploy record is therefore an
operational cost, not a display bug, and `ccqa hub deploy record` should carry
`previousSha` and a selection every time.

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
