# Evaluating the prompts

ccqa's text-only commands — `ccqa audit` and `ccqa select-specs` — are model
judgements, and a judgement you cannot measure you cannot improve. The `eval/`
tree is a self-contained benchmark for them: a small target app, drift seeded
as declared mutations with known labels, and a harness that runs the real
commands against a real checkout and scores the answers. No API key is needed
to develop against it (the tests replay a mocked Claude); a real run needs
one and costs a few model calls per case.

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

`eval/app/` is a complete little product — `node server.mjs` serves it — but
phase 1 never runs it: the audit and the selection read source, so only the
source has to exist and stay honest. The `.ccqa/` tree next to it holds a
login block and four deterministic specs (sign in, add a task, complete a
task, filter the list) whose `test.spec.ts` files are hand-written in the
shape `ccqa generate` emits, with selectors that really match the app.
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
pnpm eval:audit -- --model sonnet   # a different model
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

## What the numbers mean

**Audit.** Every audited spec in every case is scored: specs the case names
carry an expected `TEST_DRIFT` or `SPEC_CHANGE` (with `surface`,
`subDiagnosis`, `specChangeKind` where the case declares them); every other
spec is expected clean. The summary is a confusion matrix over
expected × predicted labels — the CLEAN row's off-diagonal cells are the
audit crying wolf, which the case set deliberately provokes with unrelated
changes. Most expected verdicts *are* CLEAN — each case seeds at most one
drift into a tree of several specs — so the headline accuracy has a high
base rate and answering clean to everything already scores well above 80%.
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
path. That is deliberate: the eval's job is to make prompt versions
comparable on a fixed answer key, not to be beyond argument. Change an
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
