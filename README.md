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
[`ccqa session bootstrap`](./docs/sessions.md) and name it in the spec.

## How it works

```
spec.yaml ──► ccqa record ─────► ir.json ────► ccqa generate ──► test code
 steps +       Claude drives      recorded       per-target        agent-browser
 expected      the browser and    actions as     emit              / playwright
 results       discovers the      tool-neutral   (reuse-first)     / runn
               route              IR

test code ──► ccqa run ────────► report.json ─► ccqa hub push /
               vitest replay /    + evidence      --push-report
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

**When a spec fails**, `ccqa run --failure-analysis [base]` labels the cause
— `TEST_DRIFT`, `SPEC_CHANGE`, `PRODUCT_BUG`, or `UNKNOWN` when the evidence
does not support a call. The label comes with a drift audit of the same spec,
because "did the test break" and "does the test still describe the product"
are the same investigation. `[base]` is what the diff is read against: a git
ref, or `last-green` to have each spec diff against the commit where it last
passed. With neither, the label rests on the failure alone and says so.

**Before anything runs**, `ccqa drift` asks the second question on its own,
with no browser: does each spec still describe the code? For a deterministic
spec that means both artifacts — the spec a human wrote and the test code
compiled from it — since either can fall out of step. Which one drifted
decides the repair, so the audit reports it: stale generated code is
re-recorded, a stale spec needs a human.

Every call is gradable on the hub, and the hub learns from your grades. See
[Failure triage](./docs/running.md#failure-triage) and
[Drift detection](./docs/running.md#drift-detection).

## Wire it into CI

Three jobs, each answering a different question. All of them hold one hub
secret plus one Claude credential; see
[Environment variables](./docs/commands.md#environment-variables).

**On a pull request** — replay only what the change reaches, and explain
what broke:

```bash
ccqa run --changed --failure-analysis --format github --push-report
```

`--changed` reads the diff and the spec inventory and decides, per spec,
whether the change reaches it. There is no static dependency edge from an E2E
spec to product code, so a spec that cannot be cleared runs: `unknown` is
never quietly treated as "safe". Add `--dry-run` to see the selection without
paying for the run.

**On a deploy** — record what shipped, so the next run knows what is still
trustworthy:

```bash
ccqa hub deploy record --profile staging --sha "$GITHUB_SHA" --select
```

Then `ccqa run --changed=last-run --profile staging` replays only the specs
touched since each one last ran. Each spec's baseline sits at its own point in
the deploy log, which is why the selection is recorded with the deploy rather
than computed later — without `--select` the hub has to answer `unknown`.

**On a schedule, or on push to main** — audit the specs against the codebase
with no browser at all, and notify only what needs a human:

```bash
ccqa drift --changed --base "$BEFORE_SHA" --format json --push
```

`--push` folds each verdict into a per-spec ledger the hub shows beside the
run results, so you can see at a glance which cases have drifted.

Working GitHub Actions workflows for all three:
[CI integration](./docs/running.md#ci-integration) and
[GitHub Actions example](./docs/hub.md#github-actions-example).

## The hub

A hub is optional for one person on one machine. For a team, or for CI, it is
where the shared state lives — there is no second place to put it:

- the coverage inventory of what is tested
  ([perspectives](./docs/spec.md#inventory-coverage-with-perspectives)), kept
  current by `record`/`generate`
- the variables `${…}` resolve to, and saved browser sessions, fetched at run
  time — so CI holds one secret instead of an environment
- the deploy log behind `--changed=last-run`, and the drift ledger
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
| Replay only the specs a change reaches | [Scoping with `--changed`](./docs/running.md#scoping-with---changed) |
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
