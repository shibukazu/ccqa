# 0019. A person may overrule a judgement, never a result

- Status: accepted
- Date: 2026-08-08

## Context and problem statement

ADR-0014 derives each spec's verdict from two axes the hub keeps apart: what
the audit says about the deployed commit, and how the last run ended. Both are
machine answers, and until now neither could be answered back.

That left two dead ends a person could see through and the pipeline could not.

The audit is a judgement made by reading code, and it can be wrong. A model
flagged a spec because the generated test carried a `replay-unstable` comment,
which is an observation from one replay on one day's data, not evidence about
the code. The spec described the product correctly and the deterministic run
passed. The finding parked it in `needsRepair` anyway, where nothing runs it,
and the auto-fix loop kept re-recording it into the same comment. The only way
out was to change ccqa's own prompt and ship a release.

A run that failed for an environment reason is a fact about the environment,
not about the product. Whether the environment has since been fixed is not
something the hub can observe: no run happens without a person deciding the
environment is worth spending one on, and the verdict that would justify that
decision is the one being held down by the stale failure.

Both were being solved by a single blunt instrument — an attestation that
overrode the verdict outright — which required the person to know which
mechanism applied to their situation, and offered the same escape from a
failure the test had earned honestly.

## Decision

**A person may overrule a judgement. Nobody overrules a result.**

The two things the machine says are not the same kind of claim, and the
difference decides what a person may do about each:

- An **audit finding** is a judgement, produced by reading code. A person may
  answer it: *the spec describes the code fine, this finding is wrong.* That
  settles the **audit axis** — the spec reads `clean` and goes back to being
  run like any other. It does not touch the verdict, and it does not touch the
  drift ledger: the audit's record stays the audit's.
- A **run failure classified `ENVIRONMENT`** is a result, but one that says
  nothing about the product. A person who has fixed the environment and
  confirmed the behaviour by hand may say so, and the verdict answers
  `manuallyVerified` without waiting for another run.
- A **run failure the test earned on its own terms** — `TEST_DRIFT`,
  `PRODUCT_BUG`, unclassified — is not answerable. The repair is to fix the
  test, fix the product, or find out which. The UI offers nothing there.

Two properties keep this from becoming a way to make red things green.

**The next run adjudicates.** A dismissal does not assert that the spec
passes; it asserts that the audit's objection is not a reason to skip running
it. The spec becomes `rerunNeeded`, runs on the next cycle, and the result
stands whatever the person said. Nobody has to trust a dismissal indefinitely,
which is what makes it safe to accept one on a sentence of explanation.

**Every override lapses.** A dismissal is pinned to the finding it answers —
the audit run *and* what that run said, since a human regrade rewrites the
label in place and keeps the run id. A later audit is a new observation of
newer code, so its finding stands and the earlier dismissal is shown beside it
rather than suppressing it: the machine gets to say its piece again, and the
reader learns the argument has been had before. An environment attestation
lapses the same way an ordinary verdict does — a deploy reaching the spec, the
spec being edited, a later failed run.

The reason is required on a dismissal. It is the correction a mis-firing audit
learns from, and the only durable record of why one person disagreed with the
machine.

## Consequences

The audit's own record is never rewritten, so the repair loop keeps its reason
to fix a genuinely stale test, and a dismissal cannot quietly erase a finding
for the next reader.

A dismissal is scoped per project, not per profile — a finding is about the
repository, the same reason the drift ledger has no profile (ADR-0013). The
consequence is that the hub cannot fully validate a dismissal on write: whether
the audit is *current* is a per-profile question the endpoint has no profile
to ask. A dismissal written while a deploy has overtaken the audit simply never
applies, and the next audit supersedes it.

The verdict now has to say whether a dismissal is what settled the audit axis.
A spec a later audit cleared on its own reads `clean` too, and crediting that
to a person would be a lie the detail panel repeats forever.

The UI shows at most one control per axis, chosen by what the machine said
rather than offered as a menu. A person is never asked which mechanism they
want; they are asked what they found.
