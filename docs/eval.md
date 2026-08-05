# Evaluating the prompts

ccqa's text-only commands — `ccqa audit` and `ccqa select-specs` — are model
judgements, and a judgement you cannot measure you cannot improve. The `eval/`
tree is a self-contained benchmark for them: a small target app, drift seeded
as declared mutations with known labels, and a harness that runs the real
commands against a real checkout and scores the answers. No API key is needed
to develop against it (the tests replay a mocked Claude), and a real run uses
your local Claude Code login when you have one — an API key is only needed
where no such login exists, e.g. in CI. A real run costs a few model calls
per case.

The point of the setup is the loop: edit a prompt under `src/prompts/`,
re-run the eval, compare the numbers. The commands under test always run from
this working tree via the dev entry (`bin/ccqa.ts`), so there is no build
step between the edit and the measurement.

## Layout

```
eval/
  app/       the target app: a team task tracker, plus its .ccqa tree
  cases/     one YAML file per case: mutations + the expected answers
  harness/   the runner, scoring, and its tests
  results/   per-run scored JSON (gitignored)
```

`eval/app/` is a complete little product — a team task tracker with the
stack and indirection of a real one: a Vite + React + TypeScript frontend
(`web/`, with a typed API client layer under `web/src/api/`), an Express +
better-sqlite3 backend (`server/`, with per-resource routes, a session
middleware, SQL migrations, and typed queries), and zod schemas under
`shared/` imported by both sides. Those layers are what the prompts under
test must trace: a case can mutate a route, a query, a shared schema, or the
client layer while the judgement lives in a spec that only ever names the
UI. The app really boots (`pnpm dev` inside `eval/app` — one process,
Express with Vite in middleware mode; the seeded login is in its README),
but phase 1 never runs it: the audit and the selection read source, so only
the source has to exist and stay honest. The `.ccqa/` tree next to it holds
a login block and ten deterministic specs across auth, projects, tasks,
settings, and help, whose `test.spec.ts` files are hand-written in the shape
`ccqa generate` emits, with selectors that really match the rendered markup.
The help spec is the one spec that does not include the login block, which
is what gives a block-drift case its clean bystander. Browser-driven evals
(live, record, draft) are later phases; the app's accessible markup is
already in place for them.

Everything under `eval/app/` is what the model under test reads, so nothing
in it may describe the benchmark: its README is ordinary product
documentation on purpose (a model told it sits inside a drift benchmark has
a standing reason to find drift). Harness-facing notes live in this file
only.

## Running it

```sh
pnpm eval:audit                     # all audit cases, haiku
pnpm eval:select                    # all select cases, haiku
pnpm eval:audit rename              # only cases whose name contains "rename"
pnpm eval:audit --model sonnet      # a different model
```

Each run prints a human summary and writes
`eval/results/<kind>-<timestamp>.json` with the per-spec outcomes and the
provenance the numbers need to be comparable: the model, the audit's
`DRIFT_PROMPT_VERSION`, and the run's cost (summed through the same
`CCQA_COST_FILE` machinery CI uses).

## How a case executes

For every case the harness builds a real two-commit git repo in a temp dir:
`eval/app/` as commit one, the case's mutations applied as commit two. The
audit sweeps the mutated checkout (`ccqa audit --report-format json`);
select-specs judges the diff between the two commits. The whole fixture is
thrown away afterwards.

A mutation is a search/replace pair (or a file deletion), not a diff — and it
**fails the run loudly** unless its search string occurs exactly once, both
in the untouched baseline and again at apply time (the rationale lives on
`applyMutations` in `eval/harness/mutate.ts`). `eval/harness/cases.test.ts`
applies every committed case against the committed baseline in CI, so a
rotted case fails a PR, not an eval run.

## What the case set covers

Twenty-eight cases against the current baseline app: one case per
judgement, none testing the same one twice, and specs a case does not name
are expected clean (audit) / `notNeeded` (select). Shorthand below:
`generated` is the expected `surface`, `selector` / `over-assertion` the
expected `subDiagnosis`, `removed` / `behaviour` the expected
`specChangeKind`. Where the spec prose itself quotes the renamed thing, the
stale surface is `spec` — the unscoreable schema default — so only the
label (and, where honest, the sub-diagnosis) is declared.

**Clean probes** — the audit must stay silent, the selection must clear.
Every expected verdict in this group is clean / `notNeeded`:

| Case | Kind | Seeds |
| --- | --- | --- |
| baseline-clean | audit | nothing at all |
| css-only-change | both | a presentation-only restyle |
| docs-only-change | select | a README-only edit |
| server-unrelated-change | audit | an additive endpoint no spec calls |
| refactor-bait-clean | audit | a pure rename in the project page |
| store-refactor-clean | audit | an identical-behaviour query rewrite |
| new-feature-clean | audit | a new page and nav item no spec covers |
| auth-middleware-clean | select | a guard status no spec's flow reaches |

**Test drift** (audit) — the feature survives; a surface went stale:

| Case | Expected |
| --- | --- |
| login-block-markup-drift | nine block specs: TEST_DRIFT, generated, selector |
| rename-notes-field-id | edit-task-notes: TEST_DRIFT, generated, selector |
| rename-add-button | add-task: TEST_DRIFT, selector |
| rename-complete-aria-label | complete-task: TEST_DRIFT, selector |
| stale-spec-prose | update-profile: TEST_DRIFT |
| trim-session-note | auth/login: TEST_DRIFT, generated, over-assertion |

**Spec change** (audit) — the described behaviour itself moved:

| Case | Expected |
| --- | --- |
| remove-filter-feature | filter-tasks: SPEC_CHANGE, removed |
| disable-filter-feature | filter-tasks: SPEC_CHANGE, removed |
| confirm-before-complete | complete-task: SPEC_CHANGE, behaviour |
| rework-add-flow | add-task: SPEC_CHANGE, behaviour |
| move-help-route | read-help: SPEC_CHANGE, behaviour |
| settings-maintenance-gate | update-profile: SPEC_CHANGE, kind undeclared |

**Backend tracing** — the diff sits layers away from the UI the specs name,
and the judgement is following it through the client, the routes, the
schemas, or the database to what a spec actually asserts:

| Case | Kind | Expected |
| --- | --- | --- |
| backend-default-done | audit | add-task: SPEC_CHANGE, behaviour |
| shared-name-maxlength | both | create-project: SPEC_CHANGE, behaviour; needed |
| backend-envelope-rename | select | add-task needed |
| backend-route-move | both | audit clean; complete-task + edit-task-notes needed |
| api-shared-change | select | nine specs needed; read-help notNeeded |

**Selection mechanics** (select) —

| Case | Expected |
| --- | --- |
| mixed-commit-noise | auth/login needed; the docs noise widens nothing |
| spec-own-file-change | add-task needed (mechanical, no model call) |
| block-spec-file-change | nine block specs needed (mechanical, no model call) |

**Audit** — a full run makes one model call per spec per case, so run cost
scales linearly with both counts; on haiku a full sweep of a ten-spec tree
is a few dollars.

**Select** — at most one model call per case; mechanical cases (spec-tree
changes, which are set membership) make none, and are pinned in the wiring
test so they never start costing a call.

## What the numbers mean

**Audit.** Every audited spec in every case is scored: specs the case names
carry an expected `TEST_DRIFT` or `SPEC_CHANGE` (with `surface`,
`subDiagnosis`, `specChangeKind` where the case declares them); every other
spec is expected clean. The summary is a confusion matrix over
expected × predicted labels — the CLEAN row's off-diagonal cells are the
audit crying wolf, which the case set deliberately provokes with unrelated
changes. Most expected verdicts *are* CLEAN — a case seeds drift into one
or two specs of a ten-spec tree, a block-drift case being the deliberate
flood — so the headline accuracy has a high base rate and answering clean
to everything already scores well above 80%.
The summary prints the CLEAN-row and drift-row recall beside the total;
compare prompts on those, not on the headline.

Declared sub-answers are tallied separately, and only among label-correct
predictions: a wrong label already counts against the case, and its
sub-fields answer a question that was not asked. A sub-answer whose expected
value equals the schema default (`surface: spec`, `subDiagnosis: NONE`)
cannot be scored at all — the CLI's JSON is post-parse, so a defaulted field
is indistinguishable from a model that never answered — and the case schema
rejects such an expectation.

**Select.** Scored on what would actually run: `needed` and `unknown` both
count as selected, so `unknown` is safe for the suite but paid for in
precision — exactly its cost in CI minutes. Recall is the metric that must
stay at 1.0; a false negative is a regression reaching users with the suite
green. Exact-verdict accuracy is reported alongside for prompt comparison.
A case in which `select-specs` abandoned its selection (the model call
failed and every spec fell back to `unknown`) fails the eval run instead of
being scored — scoring it would grade the fallback, not the model.

Some ground truths will sit genuinely at the boundary the prompts are asked
to draw — a removed affordance declared `SPEC_CHANGE` rather than
`TEST_DRIFT`, or a backend/frontend contract break expected clean because a
static audit may not claim `PRODUCT_BUG` (ADR-0016) and the intent the
specs describe is unchanged. That is deliberate: the eval's job is to make
prompt versions comparable on a fixed answer key, not to be beyond
argument. Change an expected answer only with the same care as changing the
prompt it measures.

## Adding a case

1. Pick the drift you want to seed and write `eval/cases/<name>.yaml`:

   ```yaml
   title: one line saying what the case seeds
   mutations:
     - file: web/src/pages/ProjectDetailPage.tsx
       search: "the exact baseline text, occurring exactly once"
       replace: "what it becomes"
   expect:
     audit:
       tasks/add-task:
         label: TEST_DRIFT
         surface: generated
     select:
       tasks/add-task: needed
   ```

2. Specs absent from `expect.audit` are expected clean; absent from
   `expect.select`, expected `notNeeded`. A case may declare either section
   or both — each eval runs the cases that declare its section.
3. Keep the mutation honest: it must break something the baseline spec
   really verifies, not pre-break the fixture. If the baseline app has to
   change, re-check every case's search strings — the cases test will tell
   you.
4. Run `pnpm test:eval` (no API key needed), then the real eval if you have
   one.
