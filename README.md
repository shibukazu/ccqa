# ccqa

> [!WARNING]
> ccqa is under active development. Expect breaking changes.

**Your Claude subscription already includes a QA engineer.**

Write a test spec in YAML. Claude drives a real browser **once** to
discover the route, and ccqa compiles the recording into plain test code
your CI replays — no model in the loop, no API key. Claude returns only
where it pays: auditing specs against the code, explaining failures, and
driving `mode: live` specs.

[日本語版 README](./docs/README.ja.md)

## Quick start

```bash
pnpm add -D ccqa vitest agent-browser   # Node 20+
```

Write a spec — `ccqa init` scaffolds the tree,
[`ccqa draft`](./docs/draft.md) writes one with you:

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

Record once, replay forever:

```bash
echo 'APP_URL=http://localhost:3000' >> .env   # ${VAR}s stay out of specs
ccqa record tasks/create-and-complete          # Claude drives the browser
ccqa run tasks/create-and-complete             # vitest replays — no LLM
```

Every run writes `report.json` and step screenshots to `ccqa-report/`.

Some logins cannot be replayed from a recording — an SSO redirect, a
device-trust prompt. Sign in by hand once with
[`ccqa hub session capture`](./docs/sessions.md), and specs start from
that saved session.

## How it works

```
spec.yaml ──► ccqa record ──► ir.json ──► test code ──► ccqa run
 steps +       Claude drives    recorded     per-target     replayed in CI,
 expected      the browser      actions      emit           no LLM
```

A spec runs in one of two ways:

**Deterministic (the default).** The recording compiles into plain test
code and CI replays it with no model in the loop. `target:` picks only
what it compiles into:

| `target:` | Generated file | Replayed by |
|---|---|---|
| `agent-browser` (default) | `test.spec.ts` (vitest) | vitest |
| `playwright` | plain `@playwright/test` spec | your `runCommand` |
| `runn` | `runbook.yaml` (API scenario, no recording) | your `runCommand` |

**Live (`mode: live`).** No codegen: Claude drives every run and judges
each step's `expected` — for UIs a fixed recording would break on.

vitest and agent-browser are peer dependencies of the default target; a
project on an external target alone needs just `ccqa` and that tool.
`runCommand` and reusing your existing page objects:
[Generation targets](./docs/targets.md).

## Audit, then run

**A spec describes the code your verification environment is running** —
not your branch, not the tip of main. A deploy moves that code, and some
specs stop describing it. Those specs are not failing; they say nothing
true about what runs, so executing them proves nothing.

So ccqa asks the cheap question before the expensive one:

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

`ccqa audit` reads each spec against the source — cents per spec, no
browser — and records every verdict on the **hub**, the small server
that holds what the team and CI share. Stale generated code is
re-recorded; a stale spec goes to a human and stays **unverified** —
neither passing nor failing — until repaired.

`ccqa run --only-hub-rerun-needed` asks the hub which specs are worth
running: cleared by the audit *and* invalidated by a deploy. A drifted spec —
or one whose last run failed — answers `needsRepair` and is never run. A run
repairs neither, and it costs dollars to learn that.

When a clean spec still fails, `--on-fail-explain` labels whose problem
it is: `TEST_DRIFT`, `SPEC_CHANGE`, `PRODUCT_BUG`, or `UNKNOWN`. You
grade the calls on the hub, and it learns from your grades.

## In CI

```
deploy lands
  ├─ ccqa hub deploy record --select   what shipped, which specs it reaches
  ├─ ccqa audit --only-hub-audit-needed --report-to-hub
  │                                    does each spec still describe it?
  └─ ccqa run --only-hub-rerun-needed --on-fail-explain \
       --hub-profile ci --report-to-hub
```

The audit costs cents; a live spec costs dollars. Filtering first leaves
a run whose failures are worth reading. Record every deploy with
`--select` — a range recorded without it answers `unknown` forever, and
nothing fills the hole later.

| Job | Trigger | Question it answers |
|---|---|---|
| Deploy loop | after a deploy | Which specs did this deploy invalidate? |
| Pre-merge run | `pull_request` | Does this change break a spec, and whose fault is it? |
| Full audit | `schedule` | Do all the specs still describe the code? |

The two jobs outside the loop:

```bash
# pull request — run what the diff reaches, label what broke
# (checkout with fetch-depth: 0, or the base ref is not there to resolve)
ccqa run --only-affected-by "origin/$GITHUB_BASE_REF" --on-fail-explain \
  --hub-profile ci --report-format github --report-to-hub

# schedule — audit everything; no browser, no deploy
ccqa audit --report-format github --report-to-hub
```

Runnable workflows and every flag:
[CI integration](./docs/running.md#ci-integration).

## The hub

You have met the hub twice now: the audit writes its verdicts there,
and the run asks it what is worth running. The same server holds the
rest of what a team shares: the variables and sessions `${…}` resolves
to (CI keeps one secret), the deploy log behind the selection flags,
run reports with screenshots, and the prompts learned from your triage
grades.

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
export CCQA_HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)
ccqa serve
```

Anything that needs the hub names it — `--hub-profile`,
`--only-hub-rerun-needed`, `--report-to-hub` — and fails rather than
degrade when it cannot reach one. A **profile** is a named value set — a
tenant, an account, a role — not an environment: ccqa tracks one
verification environment
([ADR-0013](./docs/adr/0013-one-verification-environment.md)).

## Documentation

| I want to… | Read |
|---|---|
| Write specs — fields, blocks, file uploads | [spec.yaml](./docs/spec.md) |
| Run specs and read the report | [Running](./docs/running.md) |
| Wire it into GitHub Actions | [CI integration](./docs/running.md#ci-integration) |
| Emit Playwright / runn tests | [Targets](./docs/targets.md) |
| Drive specs live, with per-project guidance | [Live specs](./docs/live.md) |
| Sign in once and reuse the session | [Sessions](./docs/sessions.md) |
| Run the team hub / script it over HTTP | [Hub](./docs/hub.md) · [API](./docs/hub-api.md) |
| Understand why it is built this way | [ADR](./docs/adr/README.md) |

## License

MIT
