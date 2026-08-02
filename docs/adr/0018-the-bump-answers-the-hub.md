# 0018. The bump answers the hub, and the diff checks the answer

- Status: accepted
- Date: 2026-08-02

## Context and problem statement

ccqa ships one npm package that is two artifacts: a CLI a consumer's CI pins,
and a hub they deploy once and leave running (ADR-0006). A version number is
the only thing that reaches the person holding that deployed hub, and it says
nothing about whether the hub is now stale — so somebody reads the diff,
decides, pins the version in a separate infrastructure repository, and carries
the answer between the two repositories from memory. That is redone every
release, and five of the 47 tags in this history carry the same date.

Deciding it by hand is going wrong in one direction. Five of the fifteen patch
releases in that history changed the hub's own source; four of those changed
nothing but the bundled UI, which nobody sees until the hub restarts. `patch`
is exactly the number a consumer reads as "nothing to do".

## Considered options

- **Split the package in two.** Two version lines, each answering for itself,
  and the question disappears. But the two sides share the contract schemas
  and the report schema, so the package boundary would cut through the middle
  of one type graph and every contract change becomes a two-repository dance —
  a breaking change for every consumer today, to answer a question a number
  can already carry.
- **Write the rule down and trust it.** Cheapest, and it is what has been
  happening. The five patch releases above are what trusting it produces.
- **Make the version carry the answer, and check the answer against the diff
  at release time.** Chosen.

## Decision

### The bump is a promise about a deployed hub

**`patch`** — no hub impact. Neither the hub's own source nor the wire
contract moved. Pin it and move on.

**`minor`** — the hub may have changed, additively. An older hub keeps
working; redeploy to pick up what is new.

**`major`** — the wire contract broke. Hub and CLI move together.

A consequence worth stating rather than discovering: **fixing a hub bug is a
`minor`.** From outside, a fix an operator must redeploy to receive is
indistinguishable from a feature they must redeploy to receive, and the number
answers the redeploy question, not the size question.

### Where each path sits

The **wire contract** — what a hub and a client must agree on to talk at all:

- `src/hub/contract/` — the REST request/response schemas. The module says so
  itself, and `ccqa/hub-client` re-exports them for clients that are neither
  of ours.
- `src/report/schema.ts` — the body a run pushes and the hub validates, stores
  and serves back. Nothing about it looks hub-shaped; it crosses the wire
  anyway.
- `docs/hub-api.md` — where that contract is stated for someone writing a
  client against it.

**Hub source** — what a deployed hub is made of, with the contract paths above
subtracted since they answer a stronger question:

- `src/hub/` — the server, its storage, and the bundled UI. The UI counts
  because the hub serves it: a UI fix reaches nobody until the hub restarts,
  which is precisely how four patch releases shipped invisibly.
- `src/cli/serve.ts` — the process a deployment runs: its flags, its defaults,
  the env it demands.
- `Dockerfile`, `.dockerignore`, `docker-compose.yaml`, `.env.example` — they
  build and run that process, and are never on a CLI consumer's path.

Three things are deliberately **not** hub source. `src/hub-client/` implements
the contract rather than defining one, and cannot require a newer hub unless
something in the contract set moved first. A `*.test.ts` anywhere ships
nowhere — `.dockerignore` deletes them from the image build context. And
everything the hub imports but does not own stays out, which is the decision
inside this decision: the import closure of `ccqa serve` is 86 modules, 30 of
them outside `src/hub/` — prompt strings, the Claude client, the spec schema.
Closing over them is exact in the sense that they are compiled into the image,
and useless in the sense that it answers "redeploy" for a spec-format change
the hub reads one constant out of. Over the 46 tag-to-tag releases in this
history the closure and the list above disagree once, on a release the contract
set already catches. A list a reviewer can read beats a graph they cannot, at
no measured cost in accuracy.

### What the gate can actually check

Two disagreements stop a release, and they are not equally well seen.

**A `patch` whose diff touched either set** contradicts the terms above with
nothing left to interpret. This is checked exactly.

**A `minor` that broke the contract rather than extending it** is invisible to
a path list, and only partly visible to anything short of running both
revisions. So the check is narrower than the sentence, and is described by what
it does: a **declared name that went away**. The routes `src/hub/api/server.ts`
registers, the keys the contract and report schemas declare, and the values
their enums allow are read at the previous tag and again at HEAD; anything
missing forces `major`.

What that does not see, and is left to review: an optional field made
required, a narrowed range, a changed status code, a route whose meaning moved
under an unchanged name. A clean result is not a compatibility guarantee. It
also over-reports in one direction — a rename, or a lift into a shared
symbol, is a name going away too — which is the honest cost of reading a
revision without building it.

### The escape hatch, and the baseline

The override is a `workflow_dispatch` input that takes **a reason**, not a flag
and not an environment variable. A non-empty reason releases past the
disagreement and is printed in the job summary and in the release body, where
it outlives whoever typed it. Both surfaces carry the same block — the impact,
the paths, and what the reader has to do — because a report nobody sees
changes nothing. The workflow did not publish GitHub Releases before this; it
does now, so that block has somewhere durable to land.

The baseline is the newest `v*` tag HEAD descends from, version-sorted so a tag
added out of order cannot become it. A gap needs no special case: the diff then
spans everything since the last surviving tag, which is the right baseline for
"what is a hub on the released version missing". No tag at all — this
repository has wiped its tags once — reports `unknown` and stops nothing. The
gate exists to catch a bump contradicted by evidence, and refusing to release
for want of a baseline would make the first release after a reset impossible.

## Consequences

**Good.** The number answers the question by itself, so nothing has to be
carried between repositories by memory. A patch release that quietly needs a
redeploy — three of them landed in one day — stops being possible without
someone typing a reason.

**Bad / cost.** The `minor` line now moves for bug fixes, so a version number
tracks redeploy impact rather than size of change. Seven of this history's
minor releases would have been stopped as majors. And the surface reader is
textual: it assumes one declaration per line, which is how these files are
written and not something the language enforces.

**Follow-up.** Nothing tells a consumer's infrastructure repository which
version its hub is on, so "is the deployed hub behind?" is still answered by
looking. That is a question about a deployment, not about a release, and it
belongs with whatever holds the deployment.

## Confirmation

Replayed over the 46 tag-to-tag releases in this history:

- **5 of the 15 patch releases stop**, and every one is a real change to a
  deployed hub — four to the bundled UI alone (1.20.1, 1.26.1, 1.26.2, 1.26.3)
  and one to the deploy store and its handler (1.16.1).
- **No release has ever removed a route.** The route check is a tripwire that
  has never fired, on purpose: it costs nothing and it is the one part of the
  surface with no ambiguity.
- **7 minor releases dropped a declared schema name.** Six were genuine
  removals: two `RunReportDataSchema` fields (1.4.0), the `relatedPaths` model
  ADR-0011 replaced (1.10.0), the `RerunState` model ADR-0014 replaced
  (1.16.0), `ReportSpecResultSchema.driftAudit` (1.19.0),
  `AuditStateSchema:cannotTell` (1.20.0), and `LiveReportCostSchema` (1.21.0).
  The seventh (1.25.0) is the over-report described above: an inline `kind`
  enum was lifted into `ReportKindSchema` and gained a member — a widening
  that reads as a removal, and exactly what the reason-carrying override is
  for.
- **One false positive disappears by construction.** 1.3.1's only path under
  `src/hub/` was a `.test.ts`.

The rules are unit-tested without a git repository or a workflow
(`src/release/hub-impact.test.ts`, `src/release/wire-surface.test.ts`); only
the entry point touches git.

## More information

- Path sets and the verdict: `src/release/hub-impact.ts`. Declared names:
  `src/release/wire-surface.ts`. Entry point: `src/release/check.ts`, also
  runnable as `pnpm release:check --bump <patch|minor|major>`.
- Workflow: `.github/workflows/release.yml` (the `Classify hub impact` step
  runs before the bump, so the diff it reads is the release's own changes).
- Related: ADR-0006 (why there is a hub to deploy at all), ADR-0007 (which side
  a capability lives on).
