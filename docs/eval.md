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
  app/       the target app: a task list with a login page, plus its .ccqa tree
  cases/     one YAML file per case: mutations + the expected answers
  harness/   the runner, scoring, and its tests
  results/   per-run scored JSON (gitignored)
```

`eval/app/` is a complete little product — one process, `node server.mjs`,
no dependencies — but it is laid out like a real one: the server file only
boots and serves static files, and everything under `/api/` lives in
`backend/` (routes, an in-memory store, input validation), with the
frontend's `public/js/api.js` as the contract counterpart of the backend
routes. That split is what lets a case mutate one layer while the judgement
lives in another — the backend-impact cases below exist because of it.
Phase 1 never runs the app: the audit and the selection read source, so only
the source has to exist and stay honest. The `.ccqa/` tree next to it holds a
login block and five deterministic specs (sign in, add a task, complete a
task, filter the list, read the help page) whose `test.spec.ts` files are
hand-written in the shape `ccqa generate` emits, with selectors that really
match the app. The help spec is the one spec that does not include the login
block, which is what gives the block-drift case its clean bystander.
Browser-driven evals (live, record, draft) are later phases; the app's
accessible markup is already in place for them.

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

This inventory is what the benchmark claims to cover: one case per
judgement, none testing the same one twice. Specs not named are expected
clean / `notNeeded`.

**Audit** — a full run makes one model call per spec per case (19 cases ×
5 specs = 95 calls), so run cost scales linearly with both counts; on haiku
that is a few dollars.

| case                       | seeds                                        | expected                                             |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| baseline-clean             | nothing at all                               | all clean                                            |
| server-unrelated-change    | server-only changes no spec observes         | all clean                                            |
| refactor-bait-clean        | internal rename, nothing observable          | all clean                                            |
| store-refactor-clean       | backend store internals refactored, identical behaviour | all clean                                 |
| new-feature-clean          | new feature no spec covers                   | all clean                                            |
| css-only-change            | presentation-only restyle                    | all clean                                            |
| backend-field-rename       | backend renames a response field the frontend reads | all clean (suspected breakage is not drift)   |
| backend-route-move         | an API route moves, frontend keeps the old path | all clean (suspected breakage is not drift)       |
| rename-add-button          | visible button label renamed                 | add-task: TEST_DRIFT/generated/SELECTOR_DRIFT        |
| rename-complete-aria-label | accessible name renamed, no visible text     | complete-task, filter-tasks: TEST_DRIFT/SELECTOR_DRIFT |
| stale-spec-prose           | on-screen copy renamed, structural selector survives | filter-tasks: TEST_DRIFT (surface `spec`, unscoreable default) |
| drop-session-note          | generated asserts what the spec never asked  | login: TEST_DRIFT/generated/OVER_ASSERTION           |
| login-block-markup-drift   | shared login block's target markup changes   | all four block-including specs: TEST_DRIFT/generated/SELECTOR_DRIFT |
| remove-filter-feature      | feature deleted outright                     | filter-tasks: SPEC_CHANGE/FEATURE_REMOVED            |
| disable-filter-feature     | feature switched off, code kept              | filter-tasks: SPEC_CHANGE/FEATURE_REMOVED            |
| rework-add-flow            | the flow's affordance replaced               | add-task: SPEC_CHANGE/BEHAVIOUR_CHANGED              |
| confirm-before-complete    | the flow gains a confirmation step           | complete-task, filter-tasks: SPEC_CHANGE/BEHAVIOUR_CHANGED |
| move-help-route            | a page moves to a new route                  | read-help: SPEC_CHANGE/BEHAVIOUR_CHANGED             |
| backend-title-minlength    | backend validation refuses the specs' data   | the three adding specs: SPEC_CHANGE/BEHAVIOUR_CHANGED |

**Select** — at most one model call per case; the two mechanical cases make
none (spec-tree changes are set membership, pinned here so they never start
costing a call).

| case                    | seeds                                        | expected needed                  |
| ----------------------- | -------------------------------------------- | -------------------------------- |
| docs-only-change        | documentation only                           | none                             |
| css-only-change         | presentation only                            | none                             |
| filter-bar-refactor     | the filter click stops re-rendering the list | filter-tasks                     |
| mixed-commit-noise      | one copy change plus docs noise              | auth/login                       |
| server-endpoint-change  | one endpoint's handler changes               | complete-task, filter-tasks      |
| api-shared-change       | the shared fetch layer changes               | the four sign-in specs           |
| backend-title-minlength | backend validation refuses the specs' data   | the three adding specs           |
| backend-field-rename    | backend renames a response field the frontend reads | the four sign-in specs    |
| backend-route-move      | an API route moves, frontend keeps the old path | complete-task, filter-tasks   |
| block-spec-file-change  | the login block's spec.yaml (mechanical)     | the four including specs         |
| spec-own-file-change    | a spec's own file (mechanical)               | that spec                        |

## What the numbers mean

**Audit.** Every audited spec in every case is scored: specs the case names
carry an expected `TEST_DRIFT` or `SPEC_CHANGE` (with `surface`,
`subDiagnosis`, `specChangeKind` where the case declares them); every other
spec is expected clean. The summary is a confusion matrix over
expected × predicted labels — the CLEAN row's off-diagonal cells are the
audit crying wolf, which the case set deliberately provokes with unrelated
changes. Most expected verdicts *are* CLEAN — a case seeds drift into one
or two specs of a five-spec tree, the block-drift case being the one
deliberate flood — so the headline accuracy has a high base rate and
answering clean to everything already scores well above 80%.
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

Some ground truths are genuinely at the boundary the prompts are asked to
draw — a removed button declared `SPEC_CHANGE` rather than `TEST_DRIFT`, a
filter-bar edit cleared for specs that render through the filter's default
path, a backend/frontend contract break expected clean because a static
audit may not claim `PRODUCT_BUG` (ADR-0016) and the intent the specs
describe is unchanged. That is deliberate: the eval's job is to make
prompt versions comparable on a fixed answer key, not to be beyond
argument. Change an
expected answer only with the same care as changing the prompt it measures.

## Adding a case

1. Pick the drift you want to seed and write `eval/cases/<name>.yaml`:

   ```yaml
   title: one line saying what the case seeds
   mutations:
     - file: public/js/tasks.js
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
