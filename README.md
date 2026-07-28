# ccqa

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder and runner. You write a
test spec in YAML; Claude drives a real browser **once** to discover the
route; ccqa compiles that recording into ordinary test code your CI replays
with no model in the loop.

Recording is where the subscription pays off — `claude` on your machine is
enough, no extra API key. CI is where it stops needing one: a recorded spec
replays as plain test code. Only the optional Claude-driven parts —
[failure analysis](#failure-analysis-and-drift), [drift](#failure-analysis-and-drift),
[change selection](#wire-it-into-ci), and `mode: live` specs — need a
credential in CI.

[日本語版 README](./docs/README.ja.md)

## Install

```bash
pnpm add -D ccqa vitest agent-browser
```

Requires Node.js **20+**.
[agent-browser](https://github.com/vercel-labs/agent-browser) and
[vitest](https://vitest.dev) are peer dependencies of the **default
agent-browser target** — they run its recorded tests. A project that only uses
an external target (`playwright`, `runn`) needs just `ccqa` plus that tool
(e.g. `pnpm add -D ccqa @playwright/test`); ccqa executes it through the
target's `runCommand`.

## Quick start

**1. Write a spec** — by hand, or interactively with
[`ccqa draft`](./docs/draft.md). (`ccqa init` scaffolds the `.ccqa/`
skeleton.)

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: Create a task and mark it complete

steps:
  - instruction: |
      Open ${APP_URL}/login. Fill in email and password, submit the form.
    expected: Redirected to /dashboard, user avatar visible in the header

  - instruction: |
      Click "New Task", fill in the title "Fix login bug", save.
    expected: Task appears in the task list with status "Open"
```

**2. Tell ccqa what `${APP_URL}` is.** A spec names variables instead of
embedding an environment, so the same spec runs against local and staging. A
`.env` file covers you locally; in CI the values come from a hub
(`ccqa hub var set`) so nothing environment-specific lives in the repo. See
[Profiles and environment variables](./docs/running.md#profiles-and-environment-variables).

```bash
echo 'APP_URL=http://localhost:3000' >> .env
```

**3. Record once** — Claude drives the browser and generates the test:

```bash
ccqa record tasks/create-and-complete
```

**4. Run it** — vitest replays the recording; no LLM involved:

```bash
ccqa run tasks/create-and-complete
```

A `report.json` (+ step screenshots) is always written to `ccqa-report/`.
See [Running specs](./docs/running.md) for flags and the report format.

If the spec sits behind a login that a recording cannot reproduce — an SSO
redirect, a device-trust gate — record a session by hand once with
[`ccqa hub session capture`](./docs/sessions.md) and name it in the spec.

## How it works

```
spec.yaml ──► ccqa record ─────► ir.json ────► ccqa generate ──► test code
 steps +       Claude drives      recorded       per-target        agent-browser
 expected      the browser and    actions as     emit              / playwright
 results       discovers the      tool-neutral   (reuse-first)     / runn
               route              IR

test code ──► ccqa run ────────► report.json ─► ccqa hub push /
               vitest replay /    + evidence      --report-to-hub
               runCommand /       + artifacts     team dashboard,
               live (Claude                       failure triage,
               drives per step)                   grading & learning
```

A spec runs in one of two ways:

**Deterministic (the default).** Claude drives the browser once
(`ccqa record`), and the recording is compiled into plain test code. From
then on, CI just replays that code — no LLM at run time, cheapest and most
stable. The `target:` field picks only **what the recording compiles
into**; every target is the same deterministic replay:

| `target:` | Generated file | Replayed by |
|---|---|---|
| `agent-browser` (default) | `test.spec.ts` (vitest + agent-browser) | vitest |
| `playwright` | `test.spec.ts` (plain `@playwright/test`) | your `runCommand` |
| `runn` | `runbook.yaml` (API scenario — compiled from the spec, no recording) | your `runCommand` |

`runCommand` is the one-line command your repo already uses to run that
tool, declared once in `.ccqa/config.yaml` — e.g.
`pnpm exec playwright test {files}`. See
[Generation targets](./docs/targets.md) for the substitution contract.

**Live (`mode: live`).** No codegen: Claude drives every run and judges
each step's `expected` — for fragile, timing-heavy UIs where a fixed
recording would break.

## Failure analysis and drift

A failing E2E test does not say whose problem it is. ccqa answers that
question in one vocabulary, from two directions.

**When a spec fails**, `ccqa run --on-fail-explain` labels the cause
— `TEST_DRIFT`, `SPEC_CHANGE`, `PRODUCT_BUG`, or `UNKNOWN` when the evidence
does not support a call. The label comes with a drift audit of the same spec,
because "did the test break" and "does the test still describe the product"
are the same investigation. `[base]` is what the diff is read against: a git
ref, or `last-green` to have each spec diff against the commit where it last
passed. With neither, the label rests on the failure alone and says so.

**Before anything runs**, `ccqa audit` asks the second question on its own,
with no browser: does each spec still describe the code? For a deterministic
spec that means both artifacts — the spec a human wrote and the test code
compiled from it — since either can fall out of step. Which one drifted
decides the repair, so the audit reports it: stale generated code is
re-recorded, a stale spec needs a human.

Every call is gradable on the hub, and the hub learns from your grades. See
[Failure triage](./docs/running.md#failure-triage) and
[Drift detection](./docs/running.md#drift-detection).

## The hub

A hub is optional for one person on one machine. For a team, or for CI, it is
where the shared state lives — there is no second place to put it:

- the coverage inventory of what is tested
  ([perspectives](./docs/spec.md#inventory-coverage-with-perspectives)), kept
  current by `record`/`generate`
- the variables `${…}` resolve to, and saved browser sessions, fetched at run
  time — so CI holds one secret instead of an environment
- the deploy log behind `--only-stale`, and the drift ledger
- a dashboard of runs with per-step screenshots, triage grading, and the
  prompts learned from those grades

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)   # required to store
ccqa serve                                               # sessions/variables
```

The repository root also ships a `Dockerfile` and `docker-compose.yaml` for
container deployment — clone it, or copy them from
[Running the hub in a container](./docs/hub.md#running-the-hub-in-a-container);
they are not part of the npm package.

See [Hub](./docs/hub.md) for the full setup and
[Hub API](./docs/hub-api.md) to script it over HTTP.

## Wire it into CI

Three jobs. They are independent: the pull-request job on its own is a
complete adoption, and the other two can come later.

| Job | Trigger | Question it answers |
|---|---|---|
| Pre-merge run | `pull_request` | Does this change break a spec, and whose fault is it? |
| Post-deploy run | after a deploy | Which specs' last result is no longer trustworthy? |
| Drift audit | `schedule` | Do the specs still describe the code? |

All three need two things:

- **A Claude credential.** Replaying a recorded spec uses no model, but the
  change selection, the failure analysis and the audit all do.
- **A running [hub](#the-hub)**, reached with `CCQA_HUB_URL` and
  `CCQA_HUB_TOKEN`. Only a pre-merge run with no `--profile` and no
  `--report-to-hub` can do without one.

See [Environment variables](./docs/commands.md#environment-variables) for the
full list.

A **profile** is one deployed environment. It names a bucket of variables and
saved sessions on the hub, and — since two environments sit at different
commits — its own deploy history. Register the variables your specs reference
once, from your machine:

```bash
ccqa hub var set APP_URL --value https://app.example --profile staging
```

Pass the same `--profile` and `--project` in every job. That is what makes the
jobs refer to the same environment.

### On a pull request

Run the specs the change reaches, and label what broke.

```bash
ccqa run --only-affected-by --on-fail-explain --profile staging \
  --report-format github --report-to-hub
```

- `--only-affected-by` selects the specs the diff reaches. A spec it cannot clear runs
  anyway.
- `--on-fail-explain` labels the cause of each failure.
- `--profile staging` fetches that environment's variables and saved sessions
  from the hub. Without it, a spec's `${…}` references go unresolved.
- `--report-format github` annotates the pull request.
- `--report-to-hub` streams results to the hub as the run executes.

**Set `fetch-depth: 0` on `actions/checkout`.** Both selection flags read
their baseline from `GITHUB_BASE_REF` and resolve it against `origin/<base>`,
which a shallow checkout does not have. Without it the run exits with a usage
error before the first test. Outside a `pull_request` workflow there is no
`GITHUB_BASE_REF`, so pass the base yourself: `--only-affected-by origin/main`.

`--dry-run` prints the selection and stops. The selection costs one model call
either way.

### On a deploy

Two steps, in two jobs. First, when the deploy succeeds, tell the hub what
shipped:

```bash
ccqa hub deploy record --profile staging --sha "$GITHUB_SHA" --select
```

Then, in a job of its own, run what that deploy invalidated:

```bash
ccqa run --only-stale --profile staging --report-to-hub
```

- `--select` records which specs the deployed range reaches. Without it, every
  spec behind that entry answers `unknown` instead of `notNeeded`.
- `--only-stale` asks the hub, per spec, whether any deploy has touched
  it since that spec last ran.

The hub has no checkout and never runs `git`, so it cannot work out what a
deploy changed. That is why the selection is submitted with the deploy rather
than reconstructed later — and why a deploy recorded without `--select` leaves
a hole nothing can fill in afterwards.

**Expect it to select nothing at first.** A spec with no recorded run is
`neverRun`; one whose baseline predates the deploy log is `unknown`. Neither
runs by default. Record a deploy, run every spec once with `--report-to-hub`,
and the selection means something from the next deploy on. This job also reads
the spec inventory from the hub, so `ccqa perspectives` has to have run.
`--only-stale-with-unknown` opts the undecided specs in.

### On a schedule

Audit every spec against the codebase, with no browser and no deploy.

```bash
ccqa audit --report-format github --report-to-hub
```

- `--exit-on warn|error` (default `error`) decides whether a verdict fails
  the job.
- `--report-to-hub` records each verdict in the hub's per-spec drift ledger, shown in
  the Perspectives tab. It never changes the exit code.
- `--only-affected-by <ref>` narrows the sweep on a `push` workflow, at the cost
  of one more model call.

The pre-merge job already audits the specs that failed. This one covers the
rest, because a spec can pass and still describe a product that no longer
exists.

### Workflows

[CI integration](./docs/running.md#ci-integration) has runnable workflows for
the pre-merge run and the scheduled audit.
[`ccqa hub deploy record`](./docs/hub.md#ccqa-hub-deploy-record) covers the
deploy job, including a `curl`-only variant for pipelines with no Node.

## Documentation

| I want to… | Read |
|---|---|
| Look up a command or an environment variable | [Command reference](./docs/commands.md) |
| Write specs: fields, reusable blocks, file uploads, coverage inventory | [spec.yaml reference](./docs/spec.md) |
| Draft specs interactively with Claude | [Draft](./docs/draft.md) |
| Generate Playwright or runn tests that reuse my existing test code | [Generation targets](./docs/targets.md) |
| Run specs and read the report | [Running specs](./docs/running.md) |
| Classify failures and grade the calls | [Failure triage](./docs/running.md#failure-triage) |
| Audit specs against the codebase without running them | [Drift detection](./docs/running.md#drift-detection) |
| Replay only the specs a change reaches | [Scoping with `--only-affected-by`](./docs/running.md#scoping-with---only-affected-by) |
| Wire ccqa into GitHub Actions | [CI integration](./docs/running.md#ci-integration) |
| Run specs live (no codegen), with per-project guidance | [Live specs](./docs/live.md) |
| Start runs already signed in / skip device-trust gates | [Saved sessions](./docs/sessions.md) |
| See which assertions generated tests use | [Assertions](./docs/assertions.md) |
| Auto-fix failing recorded tests | [Auto-fix](./docs/auto-fix.md) |
| Aggregate results, sessions, and variables on a team server | [Hub](./docs/hub.md) |
| Script the hub over HTTP | [Hub API](./docs/hub-api.md) |
| Understand why ccqa is built this way | [ADR](./docs/adr/README.md) |

## License

MIT
