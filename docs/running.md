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

- `--report [dir]` — where the report (always written) is saved. Default
  `ccqa-report/`.
- `--push-report` — stream results to a [hub](./hub.md) incrementally as
  the run executes (opt-in; needs hub credentials).
- `--profile <name>` — apply the hub-stored variables for this profile
  before resolving `${VAR}` references (below).
- `--changed [base]` — restrict execution to specs whose `relatedPaths`
  intersect the git diff against `[base]` (below). Without a value the base
  comes from `GITHUB_BASE_REF` (pull_request CI); elsewhere pass it
  explicitly (e.g. `--changed=origin/main`). Cannot be combined with
  explicit targets.
- `--concurrency <n>` — run up to N specs in parallel **within each phase**
  (never across phases). Default 1.
- `--no-evidence` — skip the step-boundary screenshots of deterministic
  specs.
- `--failure-analysis [base]` — classify each failure, on any target,
  against the source diff since `[base]` (same base rules as `--changed`).
  Off by default: no Claude calls without it. The spec↔code drift audit
  always runs with it — its findings are an input to the classification
  (and standalone via `ccqa drift`); there is no separate audit flag.
- `--format <fmt>` — `text` (default), `json` (print report.json), `github`
  (GitHub Actions annotations).
- `--retry <n>` — live specs only: retry each failing step up to N times.
- `--update-agent-prompt` — live specs only: refresh the hub-stored
  `live.agent` learning notes from this run.
- `-m/--model <name>` — `sonnet` / `opus` / `haiku` alias or a full model
  id; overrides the `CCQA_MODEL` env var. `--language <bcp47>` picks the
  language of human-readable output (default `auto` follows the
  spec/codebase). `--cwd <path>` pins the `.ccqa/` root for monorepos. All
  Claude-driven commands accept these three.
- `--project`, `--hub-url`, `--hub-token`, `--hub-header` — hub connection
  for fetching sessions/variables/prompts and for `--push-report`.

Exit code: `0` when every executed spec passed, `1` when any failed, `2` on
usage errors. The failure analysis never changes the exit code.

## Profiles and environment variables

Keep environment-specific values out of specs as `${VAR}` references and
supply them per environment:

- **Without `--profile`**, ccqa auto-loads `<cwd>/.env` if present (it does
  not override variables already set in the shell); otherwise `${VAR}`
  resolves against the existing `process.env`, so a secret manager (e.g.
  `op run -- ccqa run ...`) works as-is.
- **With `--profile <name>`**, ccqa fetches every variable stored on the
  [hub](./hub.md) for the resolved project/profile and applies them to the
  process environment (overriding inherited values) before the run starts.
  This requires a hub connection; an unreachable hub or unknown profile is
  an error. Only variable *names* are ever logged.

Register variables once per project/profile:

```bash
ccqa hub var set BASE_URL --value https://staging.example --profile staging
echo "$TOKEN" | ccqa hub var set API_TOKEN --sensitive --profile staging
ccqa run auth/login --profile staging     # same spec, staging values
```

`--sensitive` hides the value from `ccqa hub var ls` listings. The same
`--profile` also selects the sessions bucket for `session:` restores — one
flag picks both. `ccqa record` accepts `--profile` the same way.

## The run report

`ccqa run` always writes `report.json` (plus evidence PNGs) to the report
directory. There is no standalone HTML file: push the directory to a
[hub](./hub.md) (`ccqa hub push`, or incrementally with `--push-report`)
and the hub UI renders it — spec rows with a target chip, pass/fail status,
test counts, screenshots, artifacts, and failure analysis.

Per spec, the report contains:

- **Evidence** — per-step screenshots with a JSON sidecar (URL/title/status),
  under `<report-dir>/evidence/<feature>/<spec>/` and referenced from
  `report.json`. Agent-browser deterministic specs capture one boundary PNG
  per step (by default; `--no-evidence` to skip); agent-browser live specs and
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
  next, plus the drift-audit findings, the failure log excerpt, the scoped
  source diff, and the spec.yaml.

## Failure triage

With `--failure-analysis [base]`, each failing spec gets a **root-cause
call** made by Claude with the source diff since the baseline as context:

- `TEST_DRIFT` — what the spec verifies is unchanged; only the test code
  drifted from the source (selector rename, timing, over-assertion).
- `SPEC_CHANGE` — the thing being verified itself changed (UI redesign,
  spec change); the diff hunk is cited as evidence.
- `PRODUCT_BUG` — neither of the above explains the failure.
- `UNKNOWN` — evidence too weak to choose.

Alongside the label come a confidence score, a sub-diagnosis, evidence, and
reasoning. The analysis classifies; it never modifies anything.

**Any target.** The classification and the drift audit are target-agnostic.
A spec run by an external `runCommand` is analyzed from its generated test
files, the command's exit code and output tail, and its `spec.yaml` — the
same shape a vitest replay is analyzed from, and live specs supply their
Claude transcript instead. Report rows and the CI log block look identical
whichever target the spec uses.

**Diff context.** The baseline is the flag's value (`--failure-analysis
<ref>`); without a value it comes from `GITHUB_BASE_REF` (set on
`pull_request` events). There is no silent fallback: a baseline that cannot
be resolved to a local commit — including a shallow CI checkout that never
fetched it — is a startup usage error, so the classification never runs
against an accidental empty diff. For each failing spec the diff is scoped
to its `relatedPaths` globs and truncated to keep the prompt bounded; when
nothing matches, no hunks are inlined — the prompt states that explicitly
(the full changed-file list is always present, and any file's hunk is one
tool call away). The prompt also adapts its decision guidance to the
baseline: under `last-green` the range strictly covers the
passing→failing window, so a failure that no in-range change explains
leans UNKNOWN (external cause) rather than PRODUCT_BUG, and the range's
width (commits/days) is stated so wide baselines get a higher evidence
bar.

Scoping and truncation only bound the *seed* — what is pasted into the
prompt up front. The classifier itself runs agentically with read-only
tools (`Read` / `Grep` / `Glob` over the working tree, plus an in-process
`changed_file_diff` tool that serves any changed file's diff hunk from the
captured range on demand). The full list of changed files is always in the
prompt, so a change outside the spec's `relatedPaths` is still visible and
its hunk one tool call away — the full diff never has to ride in the
context.

**`--failure-analysis=last-green`.** Instead of one fixed ref, each failing
spec is diffed against the commit where **that spec last passed** — the
natural baseline for runs that have no PR to diff against (`push` /
`workflow_dispatch` / scheduled). Baselines come from the hub's last-green
ledger, updated automatically whenever a pushed or incrementally-streamed
run finalizes: every spec that passed advances its own entry to the run's
head commit, so one chronically failing spec never blocks the others'
baselines. The ledger is branch-scoped — a PR branch overlays its own
greens onto the default branch's — and requires a hub connection plus
pushed runs (`--push-report` or `ccqa hub push`) to fill. A spec with no
recorded green yet, or whose baseline commit is missing from a shallow
checkout, has its classification skipped with the reason in its report row;
the rest of the run proceeds. Each analyzed row records its own baseline in
`analysisBase`.

**Authentication.** The analysis needs `ANTHROPIC_API_KEY` (CI) or a local
Claude Code login. With neither, the report is still written — only the
analysis is skipped, with the reason recorded per spec.

### Grading and learning

The root-cause call is known to be hard, so ccqa is built
measurement-first. In the [hub UI](./hub.md#the-bundled-ui), pick the true
cause for each failing spec you review; a confusion matrix (predicted x
actual) and accuracy update live, keyed to the analysis prompt version so
prompt iterations are never mixed. Grades feed the hub's
[triage-learning](./hub.md#triage-learning) job, which writes a calibration
note that future runs fetch automatically.

Standing, human-maintained classification guidance lives in the
`triage.user` prompt (e.g. "wording changes on the settings screen count as
SPEC_CHANGE"). Write it in the hub UI's Prompts tab, or edit
`.ccqa/prompts/triage.user.md` locally and upload it with
`ccqa hub prompt push triage.user`; `ccqa run` fetches it at run time and
injects it ahead of the learned calibration note.

## Drift detection

Drift analysis asks Claude whether each `spec.yaml` is still in sync with
the current codebase — renamed aria-labels, removed routes, missing blocks,
assertions about UI that no longer exists. It is read-only: no browser, no
patches. It runs in two places:

1. **Inside `ccqa run`** — each failing spec's report entry includes a
   drift audit, used as evidence for the root-cause call above.
2. **Standalone `ccqa drift`** — a full audit without running any tests,
   for scheduled jobs or pre-merge sweeps.

```bash
ccqa drift                              # check every spec under .ccqa/features/
ccqa drift tasks/create-and-complete    # single spec
ccqa drift --format github              # emit GitHub Actions annotations
ccqa drift --severity warn              # exit non-zero on WARN or higher (default: error)
ccqa drift --concurrency 5              # parallel spec checks (default: 3)
ccqa drift --changed --base origin/dev  # only specs affected by the PR diff
ccqa drift --cwd packages/web           # monorepo: pin .ccqa root and codebase scope
ccqa drift --push                       # also push the result to a ccqa hub
```

`--push` uploads the drift result to a hub as a `kind: "drift"` run, shown
alongside `ccqa run` runs in the hub UI with its own issue counts. It needs
a hub connection (`--hub-url`/`--hub-token` or `CCQA_HUB_URL`/
`CCQA_HUB_TOKEN`); without one it logs a warning and is skipped, never
changing the exit code (still driven by `--severity`).

### Scoping with `--changed` and `relatedPaths`

When `--changed` is set (on `ccqa drift` or `ccqa run`):

1. ccqa runs `git diff --name-status <base>...HEAD`. On `ccqa run` the base
   is `--changed`'s value, else `$GITHUB_BASE_REF` — never a silent
   fallback (an unresolvable base is a usage error). On `ccqa drift` it is
   `--base`, else `$GITHUB_BASE_REF`, else `origin/main`.
2. Changed files are intersected with each spec's `relatedPaths` globs; a
   spec is in scope if any change matches.
3. For files **added** in the PR, a single lightweight Claude call maps each
   new file to the specs it plausibly affects — catching drift no existing
   glob could know about.
4. Specs with no `relatedPaths` at all are always in scope.

Supported glob syntax: `**` (any depth), `*` (run of non-slash chars), `?`
(single non-slash char) — intentionally minimal so `relatedPaths` stays
human-readable.

`relatedPaths` are interpreted relative to the cwd hosting `.ccqa/`. In a
monorepo, run from each package's directory (or use `--cwd packages/foo`)
and write paths as that package sees them; changes outside the cwd are
ignored.

## CI integration

The recommended shape: run with `--push-report` so results stream to the
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
      # --failure-analysis without a value takes its baseline from
      # GITHUB_BASE_REF, so this shape works on pull_request events. On a
      # workflow_dispatch / push workflow, use --failure-analysis=last-green
      # (each spec diffs against the commit where it last passed, from the
      # hub's ledger) or pass a ref explicitly.
      - run: pnpm exec ccqa run --project demo --profile staging --push-report --failure-analysis
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ccqa-report
          path: ccqa-report/
```

Add `ccqa-report/` to the consuming repo's `.gitignore`. Without
`--push-report`, add a separate `ccqa hub push` step with `if: always()`
instead — see [Hub](./hub.md) for the trade-off.

For a scheduled audit that runs regardless of test status, run standalone
drift:

```yaml
name: ccqa drift audit
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
      - run: pnpm exec ccqa drift --format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```
