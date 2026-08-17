# 0023. An undecided selection is not a reach

- Status: accepted
- Date: 2026-08-17

## Context and problem statement

When a deploy is recorded, `ccqa select-specs` judges per spec whether the
deploy's changed paths reach it: `needed`, `notNeeded`, or `unknown`. The
freshness read treated `unknown` the safe way: a deploy that could not be
ruled out was assumed to have reached the spec (the same posture ADR-0014
takes for holes in the deploy log), so the spec's audit went due and its
last green went stale.

In operation the safe reading proved self-defeating. The selector answers
`unknown` most readily on exactly the deploys where it matters least per
spec: a wide catch-up deploy carrying a day of merges, where hundreds of
changed paths make "this cannot affect that spec" too strong a claim for
every spec at once. One such deploy answered `unknown` for the entire
suite, and the whole board fell to "waiting" in a single record — every
green invalidated, a full audit sweep owed, and hours of re-verification
spent on specs the deploy had almost certainly not touched. A safety
default that routinely invalidates everything does not get acted on with
care; it trains the operator to ignore the board.

## Decision

An undecided selection counts as **not reached**. Only two things advance a
spec's freshness baseline:

- a `needed` judgement for that spec, and
- a deploy recorded with **no selection at all** (`--no-select-specs` or a
  selection that timed out), which still counts as reaching everything —
  there was no judgement, so there is nothing to trust.

The recording side is unchanged: an `unknown` still lands in the touch
index as `undecidedIndex`, so the ledger keeps what the selector actually
answered. The freshness read simply no longer consults it, and the
`selectionUnknown` assumed-reached annotation is no longer produced (the
wire enum keeps the value so clients can read older hubs).

Holes in the deploy log are untouched: a gap or an unplaceable range is
still treated as reached (ADR-0014). That rule is about records that are
missing; this one is about a record that exists and says "I could not
tell".

## Consequences

The cost profile inverts. A wide deploy that the selector cannot place now
invalidates nothing instead of everything; audits and re-runs are owed only
for specs somebody positively judged as touched. The 15-hour all-waiting
boards disappear, and with them the pressure to fire audits immediately
after every deploy.

The same reading applies everywhere freshness is consulted: a manual
attestation (ADR-0019) now lapses only when a `needed` or unselected deploy
reaches the case, not when one is judged `unknown` — a person's word is not
withdrawn on a shrug either.

The risk moves onto the selector's precision, deliberately. A deploy that
truly affects a spec but is judged `unknown` leaves that spec green until a
later deploy is judged `needed`, a person runs it, or its failure surfaces
some other way. That is a real gap, accepted with eyes open: the selector's
`unknown` rate is what to watch, and improving the selection (model,
prompt, or diff splitting) is the lever — not re-widening the blast
radius of a shrugged judgement.

## Alternatives considered

**Audit immediately after every recorded deploy.** Closes the window during
which an invalidated board sits waiting, but keeps the mass invalidation
itself and adds a model-priced audit per deploy. Rejected in favour of not
invalidating on a shrug in the first place.

**Split wide diffs and re-select per slice.** Would raise the selector's
decision rate on catch-up deploys, but adds machinery to the recording path
and still leaves the semantics of `unknown` punitive. Worth doing on its
own merits someday; it does not replace this decision.
