# 0020. A lapsed attestation hands the spec back to the cycle

- Status: accepted
- Date: 2026-08-14

## Context and problem statement

ADR-0019 let a person attest that a failure was environmental: the ledger keeps
the red, and the verdict reads `manuallyVerified` for as long as their word
covers what is deployed. When a deploy reaches the case the attestation lapses,
correctly — they read older code, and cannot speak for what shipped after it.

What happens next was never decided, and what happened was the worst of the
options. The verdict fell back to the red underneath, which is `needsRepair`,
which `--only-hub-rerun-needed` never takes. So a spec a person had already
answered ended up worse off than one nobody had touched: a machine-verified
spec decays from `verified` to `rerunNeeded` and rejoins the cycle, while an
attested one decayed into a dead end and stayed there until somebody noticed
and drove a run by hand.

The hub UI stated the opposite in as many words — "it lapses once a deploy
reaches this case, and normal runs resume" — and normal runs did not resume.
Nothing in the pipeline was going to select that spec again.

The underlying reason is that the red kept its full weight after the person
had answered it. `failed` means "this result is current information about the
product", and it stops being that the moment someone looks at the failure and
says what it was. The ledger should still hold the failure; what it should not
hold is the claim that nobody has dealt with it.

## Decision

**A red retired by a lapsed attestation reads `stale`, not `failed`.**

Said on the execution axis, which already carries "the last result does not
answer for what is here now" as `stale`. ADR-0014's verdict table is untouched,
and `decide()` stays a total function of the two axes plus the claim — the
property its own doc comment promises.

Two boundaries:

- **While the attestation covers, the axes are shipped unchanged.** ADR-0019's
  reader sees `execution: failed` beside `manuallyVerified`, which is what
  makes it legible what the attestation is standing in for. The demotion fires
  only once the attestation has lapsed.

- **A lapse caused by a newer red does not demote.** If a run failed *after*
  the person looked, that failure is newer than their word and nobody has
  answered it. It stays `failed`, and the spec stays `needsRepair`.

An `ENVIRONMENT` failure with no attestation is **not** covered by this and
stays `needsRepair`. That was considered and rejected: the only bucket that
asks for a person is `needsRepair`, so moving environment failures out of it
would hide a permanently broken environment from the reports and from the
`needsRepair` work list the resolve skill is built on — reintroducing the bug
ADR-0014 was written to fix. Whether the environment recovered is a judgement,
and ADR-0019 already says a person makes it.

## Consequences

Attesting is now a strict improvement on every axis. Before, a person choosing
between "attest" and "leave it" was choosing between a spec that freezes on
lapse and one that never moves at all; now the attestation carries the spec
through to the next run.

The lapse does what the UI always said it did. No wording change was needed
there, only the behaviour catching up with it.

The demoted `stale` carries none of the annotations the deploy-driven one does
— no `touchedBy`, no `touchedByDeploy` — because the deploy log was never
consulted. Readers of the axis that need the failure itself go to the ledger
(`lastRed`) rather than the axis, since a retired red no longer reads `failed`.

A person who attests over a `PRODUCT_BUG` or `TEST_DRIFT` red also gets this
behaviour, which ADR-0019 did not contemplate — its escape was framed for the
environment case. It self-corrects: the re-run either passes, or records a new
red that outranks their word and parks the spec again. Gating the demotion on
the label was considered and left out; the attestation is the judgement, and
the run that follows is what settles it.
