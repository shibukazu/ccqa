# 0017. Records the hub stores but does not judge

- Status: accepted (amended 2026-08-02 — see Amendment below)
- Date: 2026-08-02

## Context and problem statement

Every record the hub has held so far is a verdict about specs, and everything
derived from one reads it that way: a run says whether specs passed, an audit
says whether they still describe the code, and the spec ledger, the drift
ledger and the two re-run axes are all folded from those two answers.

Three additions break that assumption. `ccqa record` produces a run record
too, but it judged nothing — it says a recording happened and what it cost. A
consumer that reports the hub's verdicts onward needs to remember what it
already reported: a CI job has no memory between runs, and the hub is the only
durable thing in that loop, but what it remembers is the consumer's own
bookkeeping and not a fact about any spec. And what a job spent on Claude is a
number about the job rather than about any spec — one the hub cannot derive,
because most of the commands that spend it leave no run behind.

The symptom that forced the first is cost. Re-recording a spec is the most
expensive thing ccqa does per invocation, and it was the only spend a budget
summed over the hub could not see. The obvious fix — push it as a run — lets
a recording advance that spec's "last green", which is the one claim a
recording must never make: it produced a test, it did not check the product.

That fix reached exactly as far as runs do, which is the symptom that forced
the third. Three commands leave a run; the coverage-inventory refresh, the spec
rewrite a fix loop makes before re-recording, the spec selection a deploy
record runs and a verification audit that deliberately publishes nothing all
call Claude and leave none. So a cap summed over stored runs is not the day's
spend — while the complete number already exists and is thrown away, since
every command writes its own total to `$CCQA_COST_FILE` and nothing durable
adds those up across jobs and days.

## Considered options

- **Leave them out.** Recording spend stays invisible, every consumer
  re-invents durable bookkeeping (a committed file, a cache key) that the hub
  already knows how to store, and a budget keeps summing runs — a total that
  is complete only for the commands that leave one.
- **Give each its own concept**: a `Recording` record beside `Run`, a typed
  "already reported" document the hub understands and diffs, and a spend
  figure the hub derives from what it holds. The first duplicates machinery
  the hub has; the second puts the hub in charge of a policy only the consumer
  knows — what counts as acting, and when it landed; and the third asks for
  the one number the hub cannot reach, since the spend it never saw is exactly
  what is missing.
- **Store all three as what they are, and make "the hub does not interpret
  this" the rule** rather than an exception noted at each site.

## Decision outcome

**Chosen: store all three, interpret none.** The hub is already a control
plane that computes almost nothing (ADR-0006); these are the three records it
reads nothing into — the most it does with one is add a column of reported
numbers up.

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

### A total the hub only adds up

A spend entry is what one batch of invocations cost, under a label the
consumer chose. The hub keeps entries per project — a batch is a job's bill,
and a job can touch several environments — totals whatever window is asked
for, and reads nothing else into them.

The consequence is a rule, not a field: **a consumer that adopts the spend log
stops summing runs.** A batch covers its whole job, including the run and the
audit inside it, so reading both counts those twice. Runs keep `costUsd`
because a run's own page has to say what that run cost; a budget reads the
spend log.

The one thing the hub does key on is where a batch came from: a push carrying
the same `ciRunId` and label as a stored entry replaces it. A retried job does
spend again, but it also rewrites its cost file from scratch, so its later
total is the whole of that job — and a workflow that ends up pushing twice
cannot quietly double a project's bill, which nothing after the fact could
detect or undo.

It is also the one record here that is bounded — entries are pruned to a
90-day window as the log is appended to. An ack is replaced wholesale and a run
is its own document, but this is a single document that only ever grows, and a
budget only ever asks about the recent past. *(Amended below: runs are bounded
too, by count rather than by age.)*

## Consequences

Good: re-recording is visible on the hub at all, a budget has one number to
read instead of a sum that was never complete, and a consumer's bookkeeping
stops being a file it has to commit or a cache it has to hope survives.

Bad: three records now exist that the hub cannot reason about. A recording's
`specs` counts are real numbers about real rows that answer nothing — the view
labels them as such rather than showing a tally — an ack's keys mean whatever
wrote them, and a spend entry is a number the hub cannot check against
anything: a job killed before it reports is indistinguishable from one that
spent nothing.

Follow-up: nothing generalises the ack yet — there is no listing of names
under a project, and no expiry. Both are additive, and neither is needed
until a consumer keeps more than a handful of sets.

## Amendment (2026-08-02): runs are bounded too, by count

The spend log is described above as the one record here that is bounded. It is
now the only one bounded by **age**: a run is capped by **count**, at the
newest 200 per (project, branch), and an evicted run's artifacts and triage
grades are deleted with it (`ccqa serve --max-runs-per-branch <n>`).

The `kind: "record"` run this ADR introduced is what forced it. A recording is
left per re-recorded spec, so an automated fix loop adds several a night, and
each carries the screenshots that are most of what the hub stores. That is a
burst, and any time window admits an unbounded number of them — which is why
the two records are bounded on different axes: a spend entry is a few hundred
bytes and arrives once per job, where a run is large and arrives in clusters.

One cap covers every kind, so a night of recordings can push that branch's
executions out of what is kept. Deliberate: a per-kind cap would make "the
newest N runs" mean something different row by row, and the answer for a
project that records heavily is a larger cap.

Neither ledger is swept. Both are one small document per branch, and an entry
already carries everything a verdict needs, so an entry outlives the run it
names: `GET /runs/:id` then answers 404 and the UI's run page says the run is
no longer kept. Pinning referenced runs was the alternative, and was
rejected: it pins the *oldest* runs indefinitely and grows with the spec count
rather than with the cap, which is not a bound.

## More information

- Run kinds: `src/report/schema.ts` (`ReportKindSchema`), enforced in
  `src/hub/api/handlers/runs.ts` (`updateSpecLedger`, `updateDriftLedger`,
  `resolveDeployedSha`) and read by the view's per-kind table in
  `src/hub/ui/index.ts` (`KINDS`)
- Acks: `AckStore` in `src/hub/core/storage/types.ts`, routes in
  `src/hub/api/handlers/acks.ts`, wire contract in
  [`docs/hub-api.md`](../hub-api.md#acks)
- Spend: `SpendStore` in `src/hub/core/storage/types.ts`, retention in
  `src/hub/core/storage/file/spend-store.ts`, routes in
  `src/hub/api/handlers/spend.ts`, client in `ccqa hub cost push`, wire
  contract in [`docs/hub-api.md`](../hub-api.md#spend)
- Run retention: `src/hub/core/retention.ts`, called from the push and seal
  handlers in `src/hub/api/handlers/runs.ts`, operator guide in
  [`docs/hub.md`](../hub.md#run-retention)
- Related: ADR-0006 (the hub stores, it does not execute), ADR-0009 (a run is
  immutable once terminal — a recording is too), ADR-0013 (why the drift
  ledger is not profile-scoped)
