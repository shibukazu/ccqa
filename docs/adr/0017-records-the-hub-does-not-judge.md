# 0017. Records the hub stores but does not judge

- Status: accepted
- Date: 2026-08-02

## Context and problem statement

Every record the hub has held so far is a verdict about specs, and everything
derived from one reads it that way: a run says whether specs passed, an audit
says whether they still describe the code, and the spec ledger, the drift
ledger and the two re-run axes are all folded from those two answers.

Two additions break that assumption at once. `ccqa record` produces a run
record too, but it judged nothing — it says a recording happened and what it
cost. And a consumer that reports the hub's verdicts onward needs to remember
what it already reported: a CI job has no memory between runs, and the hub is
the only durable thing in that loop, but what it remembers is the consumer's
own bookkeeping and not a fact about any spec.

The symptom that forced the first is cost. Re-recording a spec is the most
expensive thing ccqa does per invocation, and it was the only spend a budget
summed over the hub could not see. The obvious fix — push it as a run — lets
a recording advance that spec's "last green", which is the one claim a
recording must never make: it produced a test, it did not check the product.

## Considered options

- **Leave both out.** Recording spend stays invisible, and every consumer
  re-invents durable bookkeeping (a committed file, a cache key) that the hub
  already knows how to store.
- **Give each its own concept**: a `Recording` record beside `Run`, and a
  typed "already reported" document the hub understands and diffs. Both
  duplicate machinery the hub has, and the second puts the hub in charge of a
  policy only the consumer knows — what counts as acting, and when it landed.
- **Store both as what they are, and make "the hub does not interpret this"
  the rule** rather than an exception noted at each site.

## Decision outcome

**Chosen: store both, interpret neither.** The hub is already a control
plane that computes almost nothing (ADR-0006); these are the two records
where it computes nothing at all.

### A run kind that advances no ledger

`kind: "record"` is a third value on the same `Run`, so a recording gets an
id, a report, a cost and a place in the runs list for free. What it does not
get is any consequence: the spec ledger, the drift ledger and the deploy-log
lookup that stamps a run's deployed commit all decline it, because a
recording cannot be positioned against a deploy any more than it can verify
one.

That is a rule three subsystems must keep, which makes it exactly the rule a
fourth kind will break. So the vocabulary has one source (`ReportKindSchema`)
and the view asks a per-kind table whether a kind's spec counts are a
verification tally, instead of testing for `"record"`. An unrecognised kind
answers "no" — the safe direction, since a filled meter reading "N / N
passed" for a kind nothing here understands is a claim the hub never made.

### An opaque set, written after the fact

An ack is a named set of keys under `(project, profile)`. The name, the keys
and what "acted on" means are all the consumer's; the hub stores the set and
hands it back. It is the hub's first store of that kind — every sibling is
typed state the hub reasons about — and the two things it deliberately does
not do are what make it work:

**No diff.** Only the consumer knows what to do with a difference, and a hub
that computed one would still have to be told when the action landed, which
is the same write it already makes.

**Write after acting, never before.** The `PUT` records what was successfully
acted on. Issuing it first marks a failed send as delivered and the item is
never mentioned again. The hub cannot enforce the ordering — it has no idea
what the action was — so this is documented at the endpoint rather than
designed around.

Scoping it per profile sits against ADR-0013, which keeps the drift ledger
profile-free on the grounds that whether a spec still describes the code has
nothing to do with which environment runs it — and a drift verdict is the
likeliest thing to ack. It is still the right default, for the same reason
the lock store is profile-scoped: acting happens against one environment, and
a consumer that has only one passes nothing and lands in `"default"`, while
one that acts per environment cannot recover a scope the hub never kept.

## Consequences

Good: a budget summed over `costUsd` finally sees re-recording, and a
consumer's bookkeeping stops being a file it has to commit or a cache it has
to hope survives.

Bad: two records now exist that the hub cannot reason about. A recording's
`specs` counts are real numbers about real rows that answer nothing — the view
labels them as such rather than showing a tally — and an ack's keys mean
whatever wrote them, which nothing but the consumer can check.

Follow-up: nothing generalises the ack yet — there is no listing of names
under a project, and no expiry. Both are additive, and neither is needed
until a consumer keeps more than a handful of sets.

## More information

- Run kinds: `src/report/schema.ts` (`ReportKindSchema`), enforced in
  `src/hub/api/handlers/runs.ts` (`updateSpecLedger`, `updateDriftLedger`,
  `resolveDeployedSha`) and read by the view's per-kind table in
  `src/hub/ui/index.ts` (`KINDS`)
- Acks: `AckStore` in `src/hub/core/storage/types.ts`, routes in
  `src/hub/api/handlers/acks.ts`, wire contract in
  [`docs/hub-api.md`](../hub-api.md#acks)
- Related: ADR-0006 (the hub stores, it does not execute), ADR-0009 (a run is
  immutable once terminal — a recording is too), ADR-0013 (why the drift
  ledger is not profile-scoped)
