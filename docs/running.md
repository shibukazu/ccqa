# Running specs and reading results

`ccqa run` executes specs and always writes a machine-readable **run
report**. This page covers the run command, profiles, the report and its
evidence/artifacts, failure triage, drift detection, and CI integration.

## `ccqa run`

```bash
ccqa run tasks/create-and-complete    # one spec
ccqa run tasks                        # every spec under a feature
ccqa run                              # everything
ccqa run tasks auth/login             # several targets, space-separated
```

One run mixes every kind of spec; each group is dispatched by the spec's
`target:` and `mode:` fields, in phases:

1. **Deterministic** agent-browser specs — vitest replays the recorded
   `test.spec.ts`; no LLM at run time.
2. **External targets** (e.g. `playwright`, `runn`) — executed through their
   configured `runCommand`; targets without one are listed as skipped. See
   [Generation targets](./targets.md).
3. **Live** agent-browser specs — Claude drives the browser per step and
   judges each step's `expected`. See [Live specs](./live.md).

Key flags (see `ccqa run --help` for the rest):

- `--report-dir <dir>` — where the report (always written) is saved. Default
  `ccqa-report/`.
- `--report-to-hub` — stream results to a [hub](./hub.md) incrementally as
  the run executes (opt-in; needs hub credentials).
- `--hub-profile <name>` — apply the hub-stored variables for this profile
  before resolving `${VAR}` references (below).
- `--only-affected-by <ref>` — restrict execution to the specs `ccqa
  select-specs` decides the git diff against `<ref>` reaches (below). The ref
  is always explicit: in a pull_request workflow pass `$GITHUB_BASE_REF`.
- `--only-hub-rerun-needed` — restrict execution to the specs the hub answers
  `rerunNeeded` for: the audit cleared them, and their last result does not
  cover what is deployed — including every spec the deploy log cannot place,
  which is assumed reached rather than skipped. Reads the deploy log and the
  drift ledger, not a diff — see [Running only what needs a
  re-run](#running-only-what-needs-a-re-run).
- `--dry-run` — print the specs this invocation would run, then exit `0`
  without executing anything and without writing a report. Works with every
  selection flag. Each line names the phase that would run the spec, and any
  [`serialGroups`](./targets.md#serialgroups--specs-that-must-not-run-at-the-same-time)
  it belongs to — which is how you confirm a group was read rather than
  mistyped into silence.
- `--concurrency <n>` — run up to N specs in parallel **within each phase**
  (never across phases). Default 1. Specs in the same
  [`serialGroups`](./targets.md#serialgroups--specs-that-must-not-run-at-the-same-time)
  entry still take turns, so raising this does not put two specs on the same
  chat channel or shared account at once.
- `--replay-skip-evidence` — skip the step-boundary screenshots of deterministic
  specs.
- `--on-fail-explain` — classify each failure, on any target, against the
  source diff since the commit where that spec last passed (per-spec
  baselines from the hub). Off by default: no Claude calls without it. One
  call holds the execution evidence and reads the source itself, with
  tools, and answers all four causes below — see [Failure
  triage](#failure-triage).
- `--on-fail-explain-base <ref>` — diff against one shared ref instead of each
  spec's last green. Use it when there is no hub to hold the baselines.
- `--on-fail-explain-rerun <auto|always|never>` — run a failed spec a second
  time, so the label can rest on whether the failure reproduces. `never` by
  default: a rerun is a full spec execution, live specs included. `auto`
  reruns the failures whose label turns on reproducibility (`UNKNOWN`,
  `ENVIRONMENT`); `always` reruns every classified failure. See [Rerunning a
  failure](#rerunning-a-failure).
- `--on-fail-explain-rerun-max-specs <n>` — rerun at most N specs. The rest
  are named in the run summary and keep the label they were first given.
  Uncapped by default.
- `--report-format <fmt>` — `text` (default), `json` (print report.json), `github`
  (GitHub Actions annotations).
- `--live-step-retry <n>` — live specs only: retry each failing step up to N times.
- `--learn-hub-live-prompt` — live specs only: refresh the hub-stored
  `live.agent` learning notes from this run.
- `-m/--model <name>` — `sonnet` / `opus` / `haiku` alias or a full model
  id; overrides the `CCQA_MODEL` env var. `--language <bcp47>` picks the
  language of human-readable output (default `auto` follows the
  spec/codebase). `--cwd <path>` pins the `.ccqa/` root for monorepos. All
  Claude-driven commands accept these three.
- `--project`, `--hub-url`, `--hub-token`, `--hub-header` — hub connection
  for fetching sessions/variables/prompts and for `--report-to-hub`.

Every `--only-*` narrows what the one before it left, so passing several means
"all of these". None of them can be combined with explicit spec targets.

Exit code: `0` when every executed spec passed, `1` when any failed, `2` on
usage errors. The failure analysis never changes the exit code, and neither
does a rerun that passes — the spec failed.

## Profiles and environment variables

A **profile** is a named set of variables and saved sessions on the hub — a
tenant, an account, a role. It is **not an environment**: ccqa tracks one
verification environment, because there is one version of the test code and it
can only describe one deployment.

Keep the values themselves out of specs as `${VAR}` references:

- **Without `--hub-profile`**, ccqa auto-loads `<cwd>/.env` if present (it does
  not override variables already set in the shell); otherwise `${VAR}`
  resolves against the existing `process.env`, so a secret manager (e.g.
  `op run -- ccqa run ...`) works as-is.
- **With `--hub-profile <name>`**, ccqa fetches every variable stored on the
  [hub](./hub.md) for the resolved project/profile and applies them to the
  process environment (overriding inherited values) before the run starts.
  This requires a hub connection; an unreachable hub or unknown profile is
  an error. Only variable *names* are ever logged.

Register variables once per project/profile:

```bash
ccqa hub var set BASE_URL --value https://app.example --profile admin
echo "$TOKEN" | ccqa hub var set API_TOKEN --sensitive --profile admin
ccqa run auth/login --hub-profile admin     # same spec, the admin account's values
```

`--sensitive` hides the value from `ccqa hub var ls` listings. The same
`--hub-profile` also selects the sessions bucket for `session:` restores —
one flag picks both. `ccqa record` accepts `--hub-profile` the same way.

### Leftover repo-local profile files

Earlier versions read a profile's variables from `.ccqa/profiles/<name>.env`
in the repository. **ccqa no longer reads those files.** If one is still
there, its values are not in effect — the run uses the hub's values, or
`<cwd>/.env`. `ccqa run`, `ccqa record` and `ccqa generate` warn once when
they find one; the run itself is not affected, so it continues.

Move the values to the hub with `ccqa hub var set --profile <name>`, then
delete the file. If the file is tracked by git, the credentials in it are
committed: rotate them, because deleting the file now does not un-commit
what was in it.

## The run report

`ccqa run` always writes `report.json` (plus evidence PNGs) to the report
directory. There is no standalone HTML file: push the directory to a
[hub](./hub.md) (`ccqa hub push`, or incrementally with `--report-to-hub`)
and the hub UI renders it — spec rows with a target chip, pass/fail status,
test counts, screenshots, artifacts, and failure analysis.

Per spec, the report contains:

- **Evidence** — per-step screenshots with a JSON sidecar (URL/title/status),
  under `<report-dir>/evidence/<feature>/<spec>/` and referenced from
  `report.json`. Agent-browser deterministic specs capture one boundary PNG
  per step (by default; `--replay-skip-evidence` to skip); agent-browser live specs and
  Playwright specs capture a before/after pair per step. A target with no
  screen to shoot (an API runbook) records why instead. Playwright capture
  needs nothing from you — ccqa injects the calls into the generated test and
  points it at the evidence dir at run time (see
  [Generation targets](./targets.md#step-screenshots-for-external-targets)).
- **Artifacts** — for external-target specs, the command's full
  stdout+stderr as `output.log` (captured on pass and fail) plus every file
  the command wrote into its `{artifactsDir}`
  (`<report-dir>/artifacts/<feature>__<spec>/`). Collection is capped at 50
  files / 32 MB per spec; dropped files are named in a warning. The hub UI
  renders images inline, previews small text/JSON, and links the rest.
- **Failure analysis** — for failing specs, the root-cause call described
  next, the failure log excerpt, the scoped source diff, and the spec.yaml.

Run-wide, `report.json` also carries a `cost` object: what this invocation
spent on Claude, in the same fields as the `[cost]` line (see [Command and
environment reference](./commands.md#what-a-command-cost)). It covers every
call the run made — spec selection, live browsing, failure triage — so it is
a superset of the per-spec `results[].liveRun.cost`, not a sum of them.

Read the total, not the object. A deterministic run that passed calls no
model, but it still carries a `cost` whose every numeric field is `null`;
`cost` itself is null only in a report written before this field existed.
`jq '.cost.totalCostUsd'` answers "what did this run bill"; `.cost != null`
does not.

It is rewritten on every incremental flush rather than stamped once at the
end, so a run killed by a CI timeout still says what it burned. The one
thing outside it is `--learn-hub-live-prompt`, which runs after the report is
written; the `[cost]` line on stderr is the true total for the invocation.

## What leaves a run on the hub

Three commands leave a run behind, each under its own `kind`, and the hub UI
lists all three together:

| Command | `kind` | What it advances |
|---|---|---|
| `ccqa run --report-to-hub` | `run` | the spec ledger — what passed, what failed, and what still needs a re-run |
| `ccqa audit --report-to-hub` | `drift` | the drift ledger — what the audit last read, and what it found |
| `ccqa record --report-to-hub` | `record` | nothing |

A recording advances nothing on purpose: it produced a test, it did not check
the product, so it can never be the record that says a spec is green or that
the audit has caught up. It is there for one reason — an automated
re-recording loop calls Claude several times per spec, and a budget that caps
spend by summing `costUsd` over the hub's runs cannot see money that left no
run. The run carries the spec that was recorded, whether the recording
finished, and what it spent; it is sealed even when the recording throws,
since a failed recording paid for its calls all the same.

The flag needs a hub connection (`--hub-url`/`--hub-token` or
`CCQA_HUB_URL`/`CCQA_HUB_TOKEN`) and fails without one rather than recording
silently unpublished.

## Failure triage

With `--on-fail-explain`, each failing spec gets a **root-cause call** made
by Claude in a single pass: it holds the execution evidence (script,
failure log, or live transcript) and reads the source itself, with tools,
so the question is never split across two calls. It names what has to
change:

- `TEST_DRIFT` — the generated test code. What the spec verifies is
  unchanged; only the way the test reaches it went stale — a renamed
  selector, an over-tight assertion, a timing assumption. Fixed by
  re-recording.
- `SPEC_CHANGE` — the spec. The thing being verified itself changed — a
  redesigned flow, a removed feature. A human re-drafts it.
- `PRODUCT_BUG` — the product: an error response, a missing side effect,
  wrong data, a flow that no longer completes.
- `ENVIRONMENT` — nothing in the repository: a service that's down, a
  missing or expired credential, absent seeded data, a timing race. The
  cause must be named concretely; "probably flaky" is `UNKNOWN`, not
  `ENVIRONMENT`.
- `UNKNOWN` — evidence too weak to choose.

For `TEST_DRIFT` and `SPEC_CHANGE` the analysis also sets `surface`
(`spec` or `generated`) — which half of the test case is stale, and
therefore how it gets fixed: `spec` means `spec.yaml` itself has to be
rewritten (and the code regenerated after); `generated` means only the
generated code drifted, so a regeneration alone is enough.

This is the **same vocabulary** `ccqa audit` uses (see [Drift
detection](#drift-detection)) — the same words mean the same things
whichever way the diagnosis was reached. The two differ only in what they
can answer: the audit never opens a browser, so it can say `TEST_DRIFT` or
`SPEC_CHANGE` but not that the product broke or the environment failed. A
run holds execution evidence too, so it answers all four.

**If a workflow of yours switches on these labels, here is what changed.**
`TEST_DRIFT` and `SPEC_CHANGE` still come out of a run's `--on-fail-explain`
— a plain `ccqa run <spec>` is never gated on the audit clearing it first;
that gating is opt-in via `--only-hub-rerun-needed` (below). What changed
for a consumer routing on labels is that `PRODUCT_BUG` is now joined by
`ENVIRONMENT`: a failure a prior version would have called `PRODUCT_BUG`
may now come back `ENVIRONMENT` instead.

Alongside the label come a confidence score, a sub-diagnosis, evidence, and
reasoning. The analysis classifies; it never modifies anything.

**Any target.** The classification is target-agnostic, whether it runs
inside `ccqa run` or standalone as `ccqa audit`. A spec run by an external
`runCommand` is analyzed from its generated test files, the command's exit
code and output tail, and its `spec.yaml` — the same shape a vitest replay
is analyzed from, and live specs supply their Claude transcript instead.
Report rows and the CI log block look identical whichever target the spec
uses.

**Diff context.** The baseline is the flag's value (`--on-fail-explain
<ref>`); without a value it comes from `GITHUB_BASE_REF` (set on
`pull_request` events). There is no silent fallback: a baseline that cannot
be resolved to a local commit — including a shallow CI checkout that never
fetched it — is a startup usage error, so the classification never runs
against an accidental empty diff. For each failing spec the diff is
truncated to keep the prompt bounded; the full changed-file list is always
present, and any file's hunk dropped or cut by truncation is one tool call
away. The prompt also adapts its decision guidance to the baseline: under
`last-green` the range strictly covers the passing→failing window, so a
failure that no in-range change explains leans ENVIRONMENT (when nameable)
or UNKNOWN rather than PRODUCT_BUG, and the range's width (commits/days) is
stated so wide baselines get a higher evidence bar.

Truncation only bounds the *seed* — what is pasted into the prompt up
front. The classifier itself runs agentically with read-only tools (`Read`
/ `Grep` / `Glob` over the working tree, plus an in-process
`changed_file_diff` tool that serves any changed file's diff hunk from the
captured range on demand). The full list of changed files is always in the
prompt, so a file whose hunk was dropped or cut by truncation is still
visible and one tool call away — the full diff never has to ride in the
context.

**`--on-fail-explain`.** Instead of one fixed ref, each failing
spec is diffed against the commit where **that spec last passed** — the
natural baseline for runs that have no PR to diff against (`push` /
`workflow_dispatch` / scheduled). Baselines come from the hub's last-green
ledger, updated automatically whenever a pushed or incrementally-streamed
run finalizes: every spec that passed advances its own entry to the run's
head commit, so one chronically failing spec never blocks the others'
baselines. The ledger is branch-scoped — a PR branch overlays its own
greens onto the default branch's — and requires a hub connection plus
pushed runs (`--report-to-hub` or `ccqa hub push`) to fill. A spec with no
recorded green yet, or whose baseline commit is missing from a shallow
checkout, has its classification skipped with the reason in its report row;
the rest of the run proceeds. Each analyzed row records its own baseline in
`analysisBase`.

**Authentication.** The analysis needs `ANTHROPIC_API_KEY` (CI) or a local
Claude Code login. With neither, the report is still written — only the
analysis is skipped, with the reason recorded per spec.

### Rerunning a failure

`ENVIRONMENT` is the one cause with no artifact to read. When the log names
it — a refused connection, a rejected credential — the classifier can call
it; when the cause is a timing race, the only evidence that settles it is
that a second attempt passes. So `--on-fail-explain-rerun auto` runs the spec
again, and lets the result speak.

It reruns two labels. `UNKNOWN` is the one the feature exists for: a refusal
that reaches a human, most often for a flake. `ENVIRONMENT` is rerun to
confirm rather than to discover — a second pass that fails too is real
evidence that this is not the timing kind, which is worth having on a label
somebody is about to act on. `always` reruns every classified failure
instead; `never` (the default) reruns nothing.

**A rerun that passes** is the missing evidence: the failure is not
reproducible, so the cause is environmental and the label says
`ENVIRONMENT`, with the second attempt cited in the row's evidence.

**A rerun that fails again** is evidence too, but of a different kind. It
rules out the flake and names no artifact, so the label stands as first
classified and the row records that the failure reproduced. `UNKNOWN` in
particular is not promoted: "not a flake" earns none of the three causes that
point at something in the repository, and a label is only worth reading if it
was earned (see [ADR-0016](./adr/0016-one-vocabulary-two-answerable-subsets.md)).
Under `always`, a label the classifier already tied to a file — `TEST_DRIFT`,
`SPEC_CHANGE`, `PRODUCT_BUG` — is likewise left alone whichever way the rerun
goes; only the evidence line is added.

Every rerun row carries `rerun: {"outcome": "passed" | "failed"}` in
`report.json`, and the sentence the rerun added shows up in the hub UI's
evidence panel. A spec that was not rerun has no `rerun` field, and the specs
a `--on-fail-explain-rerun-max-specs` cap left out are named in the run
summary — a silent truncation would read as "everything was checked".

**The rerun's own result is not the run's result.** The spec failed; a
passing second attempt explains why the run is red, it does not turn it
green. The row keeps `status: "failed"`, the exit code and the hub's
pass/fail counts are unchanged, and the hub's last-green ledger — which
advances a spec's baseline only on a `passed` row — does not move. What the
rerun writes goes to a throwaway directory, so the failing attempt's
screenshots and artifacts stay the ones in the report.

**Cost.** Each rerun is a full spec execution, and it is billed like one: a
live spec costs its dollars again, and the `[cost]` line at the end of the
run covers reruns like everything else the command spent. That is what
`--on-fail-explain-rerun-max-specs <n>` bounds, so an environment having a
bad day does not turn into an unbounded bill — the alternative to a cap being
to turn the reruns off entirely.

### Grading and learning

The root-cause call is known to be hard, so ccqa is built
measurement-first. In the [hub UI](./hub.md#the-bundled-ui), pick the true
cause — `TEST_DRIFT`, `SPEC_CHANGE`, `PRODUCT_BUG`, or `ENVIRONMENT` — for
each failing spec you review; a confusion matrix (predicted x actual) and
accuracy update live, keyed to the analysis prompt version so prompt
iterations are never mixed. Grades feed the hub's
[triage-learning](./hub.md#triage-learning) job, which writes a calibration
note that future runs fetch automatically.

A grade whose cause is not valid for its row's kind — for example `NO_DRIFT`
on a `kind: "run"` row — is excluded from the confusion matrix and from
learning rather than converted; nothing chose that cause for this row's
kind, so folding it in would put words in the grader's mouth. The excluded
count is shown next to the kept one, so a reader sees how much stopped
counting instead of watching accuracy fall for no stated reason. The hub UI
asks for a regrade rather than hide it.

Standing, human-maintained classification guidance lives in the
`triage.user` prompt (e.g. "a stale seed-data fixture on staging always
counts as ENVIRONMENT"). Write it in the hub UI's Prompts tab, or edit
`.ccqa/prompts/triage.user.md` locally and upload it with
`ccqa hub prompt push triage.user`; `ccqa run` fetches it at run time and
injects it ahead of the learned calibration note.

## Drift detection

Drift analysis asks whether a test case is still in sync with the current
codebase — renamed aria-labels, removed routes, missing blocks, assertions
about UI that no longer exists. It is read-only: no browser, no patches.
Standalone, this is `ccqa audit` — a full sweep without running any tests,
for scheduled jobs or pre-merge sweeps. The same check is also two of the
four causes `ccqa run --on-fail-explain`'s root-cause call can reach for
(see [Failure triage](#failure-triage)) — not a separate pass, the same
question asked with more evidence available.

A `deterministic` spec is two artifacts, and the audit reads both: the
`spec.yaml` a human wrote, and the test code `ccqa generate` compiled from
it. Either can drift from the source independently, so the audit checks the
concrete selectors and strings the generated code holds, not only the prose
in `spec.yaml`. A `mode: live` spec has no generated code — the spec itself
is what runs — so only `spec.yaml` is audited there.

Each audited spec gets **at most one diagnosis**: `TEST_DRIFT` (the test
drifted from the source), `SPEC_CHANGE` (the thing being verified changed),
or `UNKNOWN` when the evidence is too weak to call. Never `PRODUCT_BUG` — a
static read can't tell a dropped side effect from a working one, so the
audit can't reach that far even though a run can (see [Failure
triage](#failure-triage)). The diagnosis carries a confidence, a headline,
a recommendation, cited evidence, and a `surface` that decides how to fix
it: `spec` means `spec.yaml` itself has to be rewritten (and the code
regenerated after); `generated` means only the generated code drifted, so
a regeneration alone is enough. No finding at all means the spec still
matches the code (`drift: null`), not a passing "check" to enumerate.

Standing guidance for the audit lives in the `audit.user` / `audit.agent`
prompts, the audit's counterpart to `triage.user` / `triage.agent` above
(see [Fetching sessions, variables, and prompts at run
time](./hub.md#fetching-sessions-variables-and-prompts-at-run-time)).

```bash
ccqa audit                              # check every spec under .ccqa/features/
ccqa audit tasks/create-and-complete    # single spec
ccqa audit --report-format github         # emit GitHub Actions annotations
ccqa audit --exit-on warn                 # exit non-zero on WARN or higher (default: error)
ccqa audit --concurrency 5                # parallel spec checks (default: 3)
ccqa audit --only-affected-by origin/dev  # only specs the PR diff reaches
ccqa audit --cwd packages/web             # monorepo: pin .ccqa root and codebase scope
ccqa audit --report-to-hub                # also push the result to a ccqa hub
```

`--report-to-hub` uploads the audit result to a hub as a `kind: "drift"` run, shown
alongside `ccqa run` runs in the hub UI with its own issue counts. It needs
a hub connection (`--hub-url`/`--hub-token` or `CCQA_HUB_URL`/
`CCQA_HUB_TOKEN`) and exits 2 without one, before the sweep spends anything —
the audit writes no local report, so a sweep that cannot publish has nothing
to show for itself.

Pushing also advances the hub's per-project **drift ledger**: each spec's
newest audit (or "no drift found") lands there, so the Perspectives tab shows
every spec's last-known drift status without opening each run individually —
see [the hub guide](./hub.md#drift-ledger).

### Scoping with `--only-affected-by`

When `--only-affected-by` is set (on `ccqa audit` or `ccqa run`):

1. ccqa runs `git diff --name-status <ref>..HEAD`, two-dot against the
   resolved base commit. The ref is always the flag's own value — nothing is
   read from the environment, and an unresolvable ref is a usage error rather
   than an empty diff.
2. `ccqa select-specs` decides which specs the diff reaches, in two passes.
   Mechanical first: a change to a spec's own `spec.yaml`/recording, or to a
   block it includes, marks that spec `needed` — set membership, no model
   call. Everything left undecided is judged against the remaining
   (product-code) changes in one Claude call, which reads the diff and each
   spec's steps and answers `needed` / `notNeeded` / `unknown` (the
   selector's own vocabulary, not the re-run verdict's), using
   Read/Grep/Glob to check the codebase. The model call is skipped
   entirely, and every remaining spec clears as `notNeeded`, when nothing
   outside `.ccqa/` changed.
3. Specs the selector could not decide come back `unknown` and stay in
   scope — the safe reading of "I don't know" is to run it, never to skip
   it.

Changes outside the cwd hosting `.ccqa/` are reported but never attributed
to a spec — a sibling package's own `.ccqa/` names its own specs and blocks,
not this project's.

### Auditing only what the deploy reached

`ccqa audit --only-hub-audit-needed` picks the sweep's targets from the hub
instead of from a diff. Per spec: has a deploy landed on the code it covers
since the audit last read it? It needs a hub connection and `--hub-profile`,
for the same reason the run side does — the deploy log is per profile.

A spec that has **never been audited** is always included, with no diff
consulted. There is no baseline for one to narrow away, which is how a spec no
deploy ever reached could otherwise stay un-audited forever — and an un-audited
spec is never run, so it would sit outside the loop indefinitely.

A spec whose **drift entry is still open** is always included too. The hub's
answer is deploy-based, and a merged fix for a drifted spec changes only the
spec tree — no deploy lands on it, so the hub alone would never call it due
again and the entry would stay open forever. A drifted spec is due until the
audit itself clears it, which is what turns a merged repair back into a
running spec.

A spec the hub **cannot answer for** is audited rather than skipped. This used
to default the opposite way from `--only-hub-rerun-needed` on a hole in the
deploy log — audit costs cents, a live run costs dollars, so the audit did
the work and the run declined it. That gap is closed now: both treat an
unplaceable range as reached (ADR-0014), so the two differ in wording, not in
what they select.

The sweep **claims** its specs while it works, so a second cycle starting
before this one finishes does not audit the same specs and write the same
ledger entries twice. Claims lapse on their own if the job dies.

This is the one `--only-*` pair that **cannot** be combined, and ccqa rejects
it. Both narrow, so together they would mean "due **and** reached by the diff"
— and a spec the hub says is due that the diff drops is never audited, so its
recorded commit never advances and it is due again next time. The run side
never runs it either. Pick the one that matches the job: the hub's answer after
a deploy, the diff on a pull request.

When there is nothing to audit, `--report-format json` says which of the four
reasons it was (`{"specs": [], "skipped": "allCurrent"}`). They are not
interchangeable: `allCurrent` is the happy path, while `noSpecsFound` usually
means a wrong `--cwd` or a checkout that did not include the spec tree.

### Asking the question on its own

`ccqa select-specs` is the same decision as a standalone command, for when
you want the verdicts without running anything — inspecting what a range
would select, or feeding the answer to another job.

```sh
ccqa select-specs --base origin/main             # against HEAD
ccqa select-specs --base <sha> --head <sha>      # an explicit range
ccqa select-specs --base origin/main --format json
ccqa select-specs --base origin/main -m sonnet   # cheaper model
ccqa select-specs --base origin/main --cwd packages/web
```

Every spec in the tree appears in the output, each with its verdict, a
one-sentence reason, and — for `needed` — the changed paths the decision
rests on. A spec whose `spec.yaml` cannot be parsed is a hard error rather
than a spec judged without reading it.

The deploy job runs the same decision as part of
[`ccqa hub deploy record`](./hub.md#ccqa-hub-deploy-record), which submits the
verdicts with the deploy so the hub can answer `--only-hub-rerun-needed`
later.

### Running only what needs a re-run

`--only-hub-rerun-needed` asks the hub which specs are worth running instead of
diffing a ref:

```bash
ccqa run --only-hub-rerun-needed --hub-profile stg
ccqa run --only-hub-rerun-needed --hub-profile stg --dry-run     # check the selection first
```

Each spec's baseline is **its own last run** — not its last green, and not a
git ref — positioned against the deploy log the deploy job feeds the hub
with [`ccqa hub deploy record`](./hub.md#ccqa-hub-deploy-record). A spec is
selected when a deploy after that point was recorded as reaching it — the
verdict `ccqa select-specs` made against that deploy's diff, submitted
alongside it (see [Deploys and re-run
selection](./hub-api.md#deploys-and-re-run-selection)). No git diff runs
locally. There is no `unknown` verdict: when the deploy log cannot place a
spec's baseline, the hub guesses by design — it assumes the deploy reached
the spec (see below) — rather than answering "I don't know".

It needs a hub connection and `--hub-profile` (the deploy log is per profile —
a spec run under one value set says nothing about another). Anything that
leaves the hub without the data to decide at all — no perspectives document,
no deploy recorded for the profile, a hub too old to serve the endpoint — is
an **error**, never an empty selection.

The hub keeps two facts apart and derives one answer from them. **The audit
axis** says whether the spec still describes the deployed code; **the execution
axis** says how the last run ended, and whether that result still covers what
is deployed (`stale` if a deploy has reached the spec since, or if the hub
can't place the run against the deploy log). Neither axis determines the
other — a spec can be clean and stale, or drifted and freshly run — so
collapsing them would lose exactly the case that matters.

| Verdict | Means | Who acts next |
| --- | --- | --- |
| `rerunNeeded` | Cleared by the audit, last result does not cover this deploy | CI runs it |
| `needsRepair` | Drift, an audit that could not decide, or a failed run | **A person** |
| `inProgress` | A job holds it, or the audit has not caught up with the deploy | Wait |
| `verified` | Cleared by the audit, last run passed against this deploy | Nobody |

Only `rerunNeeded` runs; nothing opts into the other three.

**When the hub cannot tell whether a deploy reached a spec, it assumes it
did.** An old run that predates deploy-sha tracking, a run that straddled a
deploy, a deploy recorded without a selection — none of these leaves a hole to
shrug at; each becomes `rerunNeeded` (or `inProgress`, when it's the audit
that can't place it), the same as any other stale spec. That is the safe
direction: a spec run needlessly costs a run, a spec skipped silently costs
the release. The cost is real, though — a deploy recorded without a
selection, or a missed deploy record, means a full audit sweep and a full run
of every spec behind it, and running the audit first does not reduce that,
because the execution axis stays stale regardless of what the audit answers.
`ccqa hub deploy record` should carry `--previous` and a selection every
time.

**A spec that has never run is `rerunNeeded`.** No result at all is as
uncovered as a result a deploy invalidated, and the action is identical.

**A failed spec is `needsRepair`, and no flag opts into it.** Re-running it
teaches nothing until the code it exercises moves or the spec is fixed, and a
live spec costs dollars a go. It leaves that state when a deploy reaches it
again, or when the spec is updated.

**A spec the audit rejected is `needsRepair` too.** Re-running cannot repair a
spec that no longer describes the code: it would fail for the reason the audit
already gave, or pass while verifying something the product stopped doing. The
audit axis carries which repair it needs — `TEST_DRIFT` for a stale recording,
which `ccqa record` fixes, or `SPEC_CHANGE` for a spec a human has to rewrite.

None of these is passing or failing. They are unverified, and the selection
summary counts each as its own verdict so that never reads as an all-clear. An
empty selection with any of them outstanding **exits non-zero**: "nothing to
run" must not be reported as a green run that verified nothing. See
[ADR-0010](./adr/0010-rerun-selection-from-a-deploy-log.md) and
[ADR-0013](./adr/0013-one-verification-environment.md).

While a run is executing it **claims** its specs on the hub, so a second cycle
starting before this one finishes skips what is already running rather than
driving the same flow twice. A claim lapses on its own if the job dies, so
there is nothing to clean up by hand.

## CI integration

The recommended shape: run with `--report-to-hub` so results stream to the
hub as the run executes, keep the local report directory as a backup
artifact, and hold exactly one secret (`CCQA_HUB_TOKEN`) plus
`ANTHROPIC_API_KEY` for the failure analysis. Profile variables come from
the hub (`ccqa hub var set`), not from files in the repo.

```yaml
name: ccqa
on: [pull_request]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      CCQA_HUB_URL: https://hub.example
      CCQA_HUB_TOKEN: ${{ secrets.CCQA_HUB_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # the failure-analysis diff needs the base ref
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      # --on-fail-explain without a value takes its baseline from
      # GITHUB_BASE_REF, so this shape works on pull_request events. On a
      # workflow_dispatch / push workflow, use --on-fail-explain
      # (each spec diffs against the commit where it last passed, from the
      # hub's ledger) or pass a ref explicitly.
      - run: pnpm exec ccqa run --project demo --hub-profile staging --report-to-hub --on-fail-explain
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ccqa-report
          path: ccqa-report/
```

Add `ccqa-report/` to the consuming repo's `.gitignore`. Without
`--report-to-hub`, add a separate `ccqa hub push` step with `if: always()`
instead — see [Hub](./hub.md) for the trade-off.

For a scheduled audit that runs regardless of test status, run standalone
drift:

```yaml
name: ccqa audit
on:
  schedule:
    - cron: "0 9 * * 1"   # weekly Monday 09:00 UTC
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec ccqa audit --report-format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```
