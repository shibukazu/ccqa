# 0016. One vocabulary, two answerable subsets

- Status: accepted
- Date: 2026-07-31

## Context and problem statement

A failing test has one of four causes, and each names the artifact that has
to change: `TEST_DRIFT` (the generated test code), `SPEC_CHANGE` (the
spec), `PRODUCT_BUG` (the product), or `ENVIRONMENT` (nothing in the
repo — a service, a credential, seeded data, timing). `ccqa audit` reads a
spec against the source and can answer only the first two: it never opens
a browser, so it has no standing to say the product is broken or the
environment failed. `ccqa run --on-fail-explain` holds execution evidence
too, so it can answer all four.

Grading adds two more values no model may pick. `UNKNOWN` is the model's
own honest refusal, never something a human records. `NO_DRIFT` is the
human's — the audit reported drift where there was none — and is offered
on audit rows only, since a failing test in a run always has a cause.

Two designs were tried and rejected before this one, both for the same
underlying reason: splitting "read the source" from "hold the execution
evidence" into two calls forces a label before all the evidence is in.

## Considered options

- **Rejected A — a separate run-side vocabulary**
  (`PRODUCT_BUG`/`ENVIRONMENT`/`AUDIT_MISS`), distinct from the audit's
  `TEST_DRIFT`/`SPEC_CHANGE`.
- **Rejected B — two stages, the audit deciding first.** The audit ran
  ahead of the run and gated it: only a spec the audit cleared ran at all,
  and the run then classified only what the audit had not already
  answered.
- **Chosen — one call, one vocabulary.** The run's classifier holds the
  execution evidence and reads the source itself, with tools, in a single
  call that answers all four causes.

## Decision outcome

**One call, not two.** `ccqa run --on-fail-explain` used to make two Claude
calls per failing spec: a drift audit, then a failure analysis that took
the audit's findings as an input. They are now a single call that has the
execution evidence *and* reads the source with tools — cheaper than the
two-call design and better informed than either rejected design was. The
per-row "drift audit" card is gone from the report and the hub UI; there
is no second verdict left to show.

For `TEST_DRIFT`/`SPEC_CHANGE` the analysis also sets `surface` (`spec` or
`generated`) — which half of the test case is stale, and therefore how it
is repaired.

### Which kind of spec change, as a fourth axis

`SPEC_CHANGE` alone does not say what to do with the spec, and the two
repairs are opposites: a behaviour that no longer exists means the spec is
deleted, while a behaviour that still exists but works differently means it
is rewritten and re-recorded. The audit answers that as its own field,
`specChangeKind` (`FEATURE_REMOVED` / `BEHAVIOUR_CHANGED`).

It is a separate axis rather than a `subDiagnosis` value because
`subDiagnosis` is `[...FIXABLE_DIAGNOSIS_TYPES, "NONE"]` — the shapes a
machine knows how to repair. A spec change is by definition not one of
those, so it always lands on `NONE` there, and widening that enum would
make it mean two things at once.

`FEATURE_REMOVED` is the stronger claim and has to be earned by evidence
pointing at where the implementation would be if it existed; short of that
the answer is `BEHAVIOUR_CHANGED`. There is deliberately no third value for
"cannot tell": the field is simply absent, and every reader — the hub UI,
the ledger response, any CI consumer — must leave an absent value to a
human rather than defaulting to either repair.

### Why Rejected A does not work

Two vocabularies on one report card is confusing by itself, but the
sharper problem is that it rested on a precondition that is not
guaranteed: the run being gated by the audit clearing the spec first. A
plain `ccqa run <spec>` was never actually gated that way — gating is
opt-in, via `--only-hub-rerun-needed` — so a run's classifier could face a
spec the audit had never seen, with no vocabulary left to say "the test
case is stale." `AUDIT_MISS` answers only "the audit missed something,"
which is not the same claim.

### Why Rejected B does not work

Design B was measured, not just reasoned about, and it regressed a real
case. A refactor dropped `* qty` from an order-total helper — a genuine
product bug. The audit answered `SPEC_CHANGE` at 95% confidence, while its
own recommendation said "fix the helper, then re-record the test": a
label contradicting its own advice.

This is structural, not a prompt bug. The audit sees only that the spec
and the code disagree, and `PRODUCT_BUG` is forbidden to it because it
runs nothing — a static read cannot tell a dropped side effect from a
working one. Three possible causes, two available answers, so a product
bug is forced into a drift label. Sound when nothing ran; wrong once a
test has actually failed.

### The resolution

One call holds both the source reading and the execution evidence, so
nothing has to guess before all the evidence is in. The discriminating
question the prompt now asks is **"is the code's current behaviour what
the product intends?"** — the spec and the code disagreeing is not by
itself evidence that the test case is stale; a broken product disagrees
with its spec too, since that is what "broken" means.

Plus a self-check: if the recommended action is "change the product," the
label is `PRODUCT_BUG`. A label whose own recommendation repairs a
different artifact is the wrong label — which is exactly what Rejected B's
regression above got wrong.

**Measured outcome.** On the same two-spec sample: the pre-change two-call
design scored 1/2, Rejected B scored 1/2 (a different spec), and the
merged single call scored 2/2, at 99% and 95% confidence.

### Consequences

- Good: one vocabulary means `PREDICTED_LABELS` / `ACTUAL_CAUSES` are a
  single source of truth, shared by both callers via `causesForKind` /
  `predictedForKind` — the hub UI no longer carries its own hardcoded copy
  of either side's label set.
- Good: a run's classifier costs one Claude call per failing spec instead
  of two, and is better informed — it decides with all the evidence in
  hand, rather than in two passes that cannot see each other's reasoning.
- Bad / cost: **breaking on the wire.** An older hub rejects a report
  carrying this vocabulary's rows, since it was built against a narrower
  set. `--report-to-hub` now checks the hub before spending the run, and a
  failed publish is an error rather than a warning — a published result
  that was never sealed is wrong, not missing. Upgrade the hub first.
- Neutral: **no grade already recorded is invalidated.** The run's set
  gained `ENVIRONMENT` and kept everything it had, and the audit's set is
  unchanged, so every historical grade is still valid for its row. An
  earlier draft of this ADR claimed accuracy would reset on upgrade; that
  was true of the design in "Rejected A", which narrowed the run's set,
  and is not true of this one.
- Good: a grade whose cause is not valid for its row's **kind** is now
  refused at the write path and flagged on the read path rather than
  silently counted. That is a soundness guard, not a migration: it is the
  reason the audit-side cast to `DriftLabel` is safe, where before a
  `PRODUCT_BUG` grade could reach it on a drift row.
- Follow-up: the audit gained a hub-stored guidance prompt it never had
  before, `audit.user` — the audit's counterpart to the run's
  `triage.user`. `analysis-custom-prompt`, the run's learned calibration,
  is retired into `triage.agent`. `audit.agent`, the audit's own learned
  calibration, is reserved but not delivered: no learning job writes it
  yet.

## More information

- Vocabulary and per-kind accessors: `src/report/schema.ts`
  (`FAILURE_CAUSES`, `causesForKind`, `predictedForKind`)
- Run prompt: `src/report/prompt.ts` (`ANALYSIS_PROMPT_VERSION` "13" — its
  changelog comment carries the full v13 rationale)
- Audit prompt: `src/prompts/drift.ts` (`DRIFT_PROMPT_VERSION`). Its label
  set was already `TEST_DRIFT`/`SPEC_CHANGE`; v6 added the
  `specChangeKind` axis above
- Related: ADR-0008 (label→action routing; amended by this ADR — see its
  note), ADR-0014 (the audit/execution axes `--only-hub-rerun-needed`
  reads; unaffected by this ADR)
