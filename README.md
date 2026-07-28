# ccqa

> [!WARNING]
> ccqa is under active development. Expect breaking changes.

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder and runner. You write a
test spec in YAML; Claude drives a real browser **once** to discover the
route; ccqa compiles that recording into ordinary test code your CI replays
with no model in the loop.

Recording is where the subscription pays off — `claude` on your machine is
enough, no extra API key. CI is where it stops needing one: a recorded spec
replays as plain test code. Only the optional Claude-driven parts —
[the audit and the failure analysis](#audit-then-run),
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

## Audit, then run

**A spec describes the code your verification environment is running.** Not the
code on your branch, not the tip of the default branch — the deployment you are
verifying, as it stands. Everything below follows from that one sentence.

A deploy moves that code, and some specs stop describing it. Those are not
tests that fail; they are tests that no longer say anything true about what is
running, so executing them tells you nothing. The audit is what asks the
question, and it is answered before anything runs.

```
        the code the verification environment is running
                            │
                            │  a spec describes this
                            ▼
              the deployed commit changes
                            │
                            ▼
           audit the specs that change reaches
                            │
      still describes it ───┴─── no longer describes it
              │                            │
              ▼                            ▼
           run it                   repair the spec
                                           │
                                  re-audited next round;
                                  unverified until then
```

Only the specs the change reaches are audited, and only the ones that still
describe the deployment are run. A spec awaiting repair is **not** a passing
spec and **not** a failing one — it is unverified, and says so.

**First, without a browser: does each spec still describe the code?**
`ccqa audit` reads the spec against the source. For a deterministic spec that
means both artifacts — the spec a human wrote and the test code compiled from
it — since either can fall out of step. Which one drifted decides the repair,
so the audit reports it: stale generated code is re-recorded, a stale spec
needs a human. Cents per spec, no environment required.

**Then run what it cleared — and when something still fails, say whose problem
it is.** A failing E2E test does not tell you that on its own.
`ccqa run --only-hub-audited-clean --on-fail-explain` executes only the specs
the audit found no drift in, and labels each failure `TEST_DRIFT`,
`SPEC_CHANGE`, `PRODUCT_BUG`, or `UNKNOWN` when the evidence does not support
a call. Each spec is read against the commit where it last passed, taken from
the hub; `--on-fail-explain-base <ref>` diffs against one shared ref instead,
for when there is no hub to hold the baselines.

The order is what makes the second step worth paying for. A spec the audit
flagged will fail for a reason you have already been told, and finding that
out again costs a live run instead of a static read. Filter first and the
failures that remain are the ones no amount of reading could have caught.

A spec nobody has audited is not run either — `--only-hub-audited-clean` acts
on a verdict, and "never looked" is not one.

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
- the deploy log behind `--only-hub-stale`, and the drift ledger
- a dashboard of runs with per-step screenshots, triage grading, and the
  prompts learned from those grades

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)   # required to store
ccqa serve                                               # sessions/variables
```

**Anything that needs the hub says so in its name** — `--hub-profile`,
`--only-hub-stale`, `--only-hub-audited-clean`, `--learn-hub-live-prompt`,
`--report-to-hub` — and fails when it cannot reach one. Asking for hub-backed
selection and silently getting an unfiltered run, or asking to publish and
silently not publishing, are worth stopping for.

The repository root also ships a `Dockerfile` and `docker-compose.yaml` for
container deployment — clone it, or copy them from
[Running the hub in a container](./docs/hub.md#running-the-hub-in-a-container);
they are not part of the npm package.

See [Hub](./docs/hub.md) for the full setup and
[Hub API](./docs/hub-api.md) to script it over HTTP.

## Wire it into CI

**Audit first, then run what the audit cleared.** That order is the whole
shape of ccqa in CI:

```
deploy lands
  │
  ├─ ccqa hub deploy record --select     what shipped, and which specs it reaches
  │
  ├─ ccqa audit --report-to-hub          does each spec still describe the code?
  │                                      static: no browser, cents per spec
  │
  └─ ccqa run --only-hub-audited-clean --only-hub-stale --on-fail-explain
                                         run only what the audit cleared and
                                         the deploy invalidated
```

The audit costs cents; a live spec costs dollars. Running a spec the audit has
already flagged spends the expensive step to rediscover something the cheap one
knew — and the failure it produces is the drift you were already told about,
not news. Filtering first leaves a run whose failures are worth reading.

Two jobs sit outside that loop. A `pull_request` run catches breakage before it
merges; a scheduled audit covers the specs the deploy path never reaches.

| Job | Trigger | Question it answers |
|---|---|---|
| Deploy loop | after a deploy | Which cleared specs did this deploy invalidate? |
| Pre-merge run | `pull_request` | Does this change break a spec, and whose fault is it? |
| Full audit | `schedule` | Do the specs still describe the code? |

All of them need two things:

- **A Claude credential.** Replaying a recorded spec uses no model, but the
  change selection, the failure analysis and the audit all do.
- **A running [hub](#the-hub)**, reached with `CCQA_HUB_URL` and
  `CCQA_HUB_TOKEN`. Only a pre-merge run with no `--hub-profile` and no
  `--report-to-hub` can do without one.

See [Environment variables](./docs/commands.md#environment-variables) for the
full list.

A **profile** is a named set of variables and saved sessions on the hub — a
tenant, an account, a role. It is **not an environment**.

Point a spec wherever you like while developing; what ccqa *tracks* is one
verification environment. There is a single version of the test code, and it can
only describe one deployment — which is what the drift audit and the re-run
verdict are both about. Register the variables your specs reference once, from
your machine:

```bash
ccqa hub var set APP_URL --value https://app.example --profile admin
```

Pass the same `--hub-profile` and `--project` in every job. That is what makes the
jobs refer to the same environment.

### On a pull request

Run the specs the change reaches, and label what broke.

```bash
ccqa run --only-affected-by "origin/$GITHUB_BASE_REF" --on-fail-explain \
  --hub-profile ci --report-format github --report-to-hub
```

- `--only-affected-by <ref>` selects the specs the diff against `<ref>` reaches.
  A spec it cannot clear runs anyway.
- `--on-fail-explain` labels the cause of each failure.
- `--hub-profile ci` fetches that profile's variables and saved sessions
  from the hub. Without it, a spec's `${…}` references go unresolved.
- `--report-format github` annotates the pull request.
- `--report-to-hub` streams results to the hub as the run executes.

**Pass the base ref yourself.** ccqa reads nothing from the environment: on a
`pull_request` workflow that means `origin/$GITHUB_BASE_REF`, elsewhere
whatever you are comparing against. An unresolvable ref is a usage error
before the first test, never an empty diff.

**Set `fetch-depth: 0` on `actions/checkout`,** or that base is not in the
checkout to resolve.

`--dry-run` prints the selection and stops. The selection costs one model call
either way.

### On a deploy

Two steps, in two jobs. First, when the deploy succeeds, tell the hub what
shipped:

```bash
ccqa hub deploy record --profile ci --sha "$GITHUB_SHA" --select
```

Then, in a job of its own, run what that deploy invalidated:

```bash
ccqa run --only-hub-stale --hub-profile ci --report-to-hub
```

- `--select` records which specs the deployed range reaches. Without it, every
  spec behind that entry answers `unknown` instead of `notNeeded`.
- `--only-hub-stale` asks the hub, per spec, whether any deploy has touched
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
`--only-hub-stale-with-unknown` opts the undecided specs in.

### On a schedule

Audit every spec against the codebase, with no browser and no deploy.

```bash
ccqa audit --report-format github --report-to-hub
```

- `--exit-on warn|error` (default `error`) decides whether a verdict fails
  the job.
- `--report-to-hub` records each verdict in the hub's per-spec drift ledger,
  shown in the Perspectives tab. It is what `--only-hub-audited-clean` reads.
- `--only-affected-by <ref>` narrows the sweep on a `push` workflow, at the cost
  of one more model call.

The pre-merge job already audits the specs that failed. This one covers the
rest, because a spec can pass and still describe a product that no longer
exists.

Once the ledger is being kept, the post-deploy run can require it — spend a
run only where the audit cleared the spec **and** the last result no longer
holds:

```bash
ccqa run --only-hub-audited-clean --only-hub-stale --hub-profile ci --report-to-hub
```

Every `--only-*` narrows what the one before it left, so they compose.

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
