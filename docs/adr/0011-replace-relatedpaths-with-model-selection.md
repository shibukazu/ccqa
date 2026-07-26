# 0011. Replace `relatedPaths` glob matching with `ccqa select-specs` model selection

- Status: accepted
- Date: 2026-07-26

## Context and problem statement

`relatedPaths` was a `spec.yaml` field: a list of glob patterns naming the
source files a spec depends on, authored by `ccqa draft` / `ccqa record` and
committed alongside the spec. It powered every "which specs does this change
affect?" question: `ccqa drift --changed` / `ccqa run --changed` intersected
a git diff against the declared globs, and the hub matched a deploy's
`changedPaths` against the same field (ADR-0010) to answer
`ccqa run --changed=last-run`.

Measured against a real downstream project, this collapsed almost all
discrimination: 24 specs resolved to only 5 distinct `relatedPaths` sets.
The root cause is structural, not an authoring-quality problem. An E2E spec
has no static dependency edge to product code — it verifies user-observable
behavior reached through runtime-determined code paths (imports, shared
components, feature flags, a backend call graph) that no human- or
LLM-authored glob list can approximate without either matching almost
everything (no discrimination) or missing real changes (a false, confident
`notNeeded` — the exact danger ADR-0010's "Bad / cost" section already named).
Authored once and never revisited, the list also rotted as the codebase
moved: renamed directories and refactors left stale patterns nobody was
prompted to fix.

## Considered options

- Keep `relatedPaths` but improve accuracy (broader directory globs, refresh
  it more often via `record`). Rejected: the measurement shows the ceiling is
  structural — no static edge exists to approximate — so tightening the globs
  only trades false negatives for false positives, never removing both.
- Compute "which specs does this diff affect" via static analysis (an import
  graph, a route table). Rejected: ccqa is product/framework-agnostic by
  design and cannot assume a particular bundler, router, or language whose
  graph it could walk.
- Replace the static declaration with a per-invocation, model-based judgment:
  read the diff and each spec's actual steps, and decide
  `needed` / `notNeeded` / `unknown` at the moment the question is asked, via
  `ccqa select-specs`. (chosen)

## Decision outcome

Chosen option: "ask a model at decision time", because the question — does
this diff affect what this spec verifies? — is semantic, not structural, and
only something that can read both the diff and the spec's intent can answer
it with useful precision.

`relatedPaths` is removed entirely: from the spec schema, the perspectives
document, and every consumer (`ccqa drift --changed`, `ccqa run --changed`,
the hub's `deploy record` / rerun ledger, the failure-analysis diff scoping,
codegen prompts). `ccqa select-specs` becomes the sole mechanism. Given a
base/head range and the spec inventory, it mechanically resolves anything
that is set membership — a change to the spec's own file, or to a block it
includes — and puts everything else to one Claude call per invocation,
answering `needed` / `notNeeded` / `unknown` with `touchedBy` evidence.
`unknown` runs and `notNeeded` is skipped, the same fail-safe direction
`relatedPaths` used, but without a maintained artifact to rot.

The hub side of ADR-0010 keeps its shape — the deploy log, the ledger, the
five-state vocabulary, position-based (not wall-clock) comparison. Only the
fact it folds changes: instead of the hub intersecting `changedPaths` against
a spec's stored `relatedPaths` at read time, the deploy job now runs
`ccqa select-specs` locally (it has the checkout; the hub still never does)
and posts the resulting per-spec verdicts alongside the deploy
(`RecordDeployRequest.selection`). The hub still runs no git and calls no
model — it only folds the submitted verdicts into a touch index, the same
set-arithmetic posture ADR-0010 established.

### Consequences

- Good: no more authored artifact to keep in sync with the codebase —
  nothing to draft, review, or let rot. Precision is measured per decision
  instead of frozen at authoring time.
- Good: the model reads the actual spec steps and the actual diff, so it can
  tell apart specs that share a top-level directory but assert different
  things — the discrimination `relatedPaths` could not provide.
- Bad / cost: a Claude call (latency and cost) now sits on the critical path
  of `--changed` and of the deploy-record hook, where glob matching was
  free. Mitigated by the mechanical pass settling the common cases (spec/
  block-only edits, non-product commits) with no model call at all.
- Bad / cost: the verdict is no longer byte-reproducible — `reason` /
  `touchedBy` are model output, not a deterministic computation. Accepted:
  ADR-0010's own data-quality section already conceded `relatedPaths` could
  be silently wrong in the dangerous direction; an occasionally-imprecise
  but inspectable verdict is preferable to a confidently wrong static one.
- Bad / cost: the verdict is made against the specs as they stood when the
  deploy landed and is not revisited. A spec edited afterwards is not
  retroactively re-judged — its own change marks it `needed` at the next
  deploy instead. The mechanism it replaces had the mirror flaw, and worse:
  a stale `relatedPaths` list re-interpreted the whole history on every read.

### Confirmation

Typecheck and the full unit suite pass with `relatedPaths` removed from the
schema, prompts, every hub-contract consumer, and the docs.

The decision was measured before it was made, against a real downstream
project's history. On a commit that suspended one feature, `relatedPaths`
selected 23 specs and `select-specs` selected 3 — the three the diff was read
by hand to confirm. Two of those three are not tests of that feature: they
reach it through a cleanup step, a link no path glob can express. On three
other commits `relatedPaths` selected 7, 7 and 15 specs where the correct
answer was 0, and on a commit that edited 15 spec files it selected none.

The full path — `select-specs` → `hub deploy record --select` → `GET /rerun`
— was then exercised against a local hub with that project's spec tree: a
deploy recorded without a selection leaves every spec `unknown`, and the same
deploy recorded with one yields the three `needed` verdicts with their
`touchedBy` evidence.

## More information

- ADR-0010 (`0010-rerun-selection-from-a-deploy-log.md`) — this ADR
  supersedes its `relatedPaths`-matching mechanism specifically: the
  "intersect `changedPaths` with each spec's `relatedPaths`" option in
  "Considered options", and the `relatedPaths`-worded state definitions in
  "States, and refusing to overstate". ADR-0010's deploy-log architecture,
  ledger states, position-based comparison, and scope key are unaffected and
  remain in force — only *what decides the verdict* changed, from a static
  declaration matched by the hub to `ccqa select-specs`'s model judgment, run
  by the deploy job and submitted with the deploy.
- `src/select/analyze.ts`, `src/select/inventory.ts`,
  `src/prompts/select-specs.ts`, `src/cli/select-specs.ts`,
  `src/cli/changed-specs.ts` — `ccqa select-specs` and its `--changed`
  integration.
- `src/hub/contract/schema.ts` (`DeploySelectionSchema`, `SpecTouchSchema`) —
  the wire shapes a deploy's selection is submitted in and folded into.
