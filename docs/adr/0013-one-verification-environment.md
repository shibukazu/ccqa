# 0013. One verification environment; a profile is a value set, not an environment

- Status: accepted
- Date: 2026-07-29

## Context and problem statement

`--hub-profile` names a bucket of variables and saved sessions on the hub. The
documentation described it as "one deployed environment", the flag's own help
offered `dev/stg/prd` as the example, and the deploy log is keyed by it with the
justification that "two environments sit at different commits".

Read that way, ccqa appears to support verifying several environments at once.
Following the reading through the drift audit shows it cannot.

The audit compares a spec against the source it describes: `spec@X` versus
`source@X`, both read out of the repository at one commit. The answer is a
property of that commit. But a *run* exercises whatever commit is deployed. If
two environments sit at different commits, the same spec would need two
different answers, and there is only one spec — one file, one version, in one
repository.

Worked through concretely: dev at `X`, staging frozen at an older `Y`. Audit at
`X`, find drift, fix the spec to match `X`, then run that spec against `Y`. The
fix describes code staging is not running. The audit was right about `X` and
useless for `Y`, and the repair actively made the staging run wrong.

The escape is not to store a spec per environment. It is to notice that the
question was mis-scoped: **there is one version of the test code, so it can
describe one deployment.**

## Considered options

- **Per-environment spec storage on the hub.** Each environment gets its own
  copy of the specs, versioned independently. Solves the audit, but moves test
  code out of the repository into a service, where it cannot be reviewed,
  branched, or reverted with the change that caused it. Rejected on that alone.
- **Audit at the deployed commit, per environment, keeping several ledger
  entries per spec.** Correct, and no spec is copied — git already holds every
  version. But it makes every consumer carry an environment dimension, for a
  shape most projects do not have: verification usually happens in one place.
- **One verification environment.** Chosen.

## Decision

**ccqa assumes a single environment to verify against.** The drift audit and
the re-run verdict are both about the commit that environment runs. Verifying
two environments at different commits from one repository is out of scope.

Stated positively: **a spec describes the code the verification environment is
running.** A deploy that moves that code can leave a spec describing something
else, and such a spec is neither passing nor failing — it says nothing true
about what is running, and is repaired before it is executed again.

**A profile is a named set of variables and saved sessions — a tenant, an
account, a role. It is not an environment.** Nothing stops a spec from being
pointed at a local server while developing; what ccqa *tracks* is one
deployment.

This is why the drift ledger has no profile in its key, and always did
(`drift-ledger/<project>/<branch>.json`). Drift is a repository-internal
question. The implementation was already right; the documentation described a
different tool.

The consequence for the audit is that it reads the commit the verification
environment is running, not the tip of the default branch. Auditing the tip
answers a question about code nobody is running yet.

The consequence for the run is a third answer. A spec the audit rejected is
`blocked`, alongside `needed` and `notNeeded`, and no flag opts into running
it: re-running cannot repair a spec that no longer describes the code. The
state carries which repair it needs, because `testDrift` clears itself within
minutes (`ccqa record`) and `specChange` waits for a human — treating them
alike would hide the one that accumulates. Only a finding blocks: a spec never
audited, or one the audit could not judge, is not withheld, or no newly written
spec would ever run.

## Consequences

**Good.** The audit and the run agree by construction, because they are about
the same commit — the sha-consistency check they would otherwise need is
unnecessary. Test code stays in the repository, one version, reviewed with the
change that caused it. Projects that verify in one place — the common case —
carry no environment dimension they do not use.

**Bad / cost.** A project that genuinely gates through two environments cannot
have ccqa track both. It can point runs at either (profiles carry the values),
but the drift ledger and the re-run verdict describe one. Splitting them would
need the per-commit ledger the second option above describes, which is a
migration, not a flag.

**Known conflation, not fixed here.** The deploy log lives under
`deploys/<project>/<profile>/` alongside the spec ledger. The spec ledger
belongs per profile — a spec run as one tenant says nothing about another. The
deploy log does not: which commit is live is a property of the environment, so
with several profiles the same shas are recorded once per profile. Harmless,
but the layout reinforces the reading this ADR rejects. Moving it under the
project is a storage migration and is left for when something needs it.
