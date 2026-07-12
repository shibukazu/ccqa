# ccqa

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder and runner:

1. Write a test spec in YAML — plain steps and expected results.
2. Claude drives a real browser **once** to discover the route
   (`ccqa record`).
3. ccqa compiles the recording into runnable test code for your `target:`
   — vitest replay, plain Playwright, or a runn runbook.
4. `ccqa run` replays everything into one report you can push to a
   shared hub.

No extra API key. Just `claude`.

[日本語版 README](./docs/README.ja.md)

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
`pnpm exec playwright test {files}`. ccqa substitutes the spec's generated
test files for `{files}` and a per-spec artifacts directory for
`{artifactsDir}`; see [Generation targets](./docs/targets.md) for the full
contract.

**Live (`mode: live`).** No codegen: Claude drives every run and judges
each step's `expected` — for fragile, timing-heavy UIs where a fixed
recording would break.

Either way, every failing spec gets a root-cause call (TEST_DRIFT /
SPEC_CHANGE / PRODUCT_BUG) you can grade on the hub — and the hub learns
from your grades.

## Install

```bash
pnpm add -D ccqa vitest agent-browser
```

Requires Node.js **20+**.
[agent-browser](https://github.com/vercel-labs/agent-browser) and
[vitest](https://vitest.dev) are peer dependencies.

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

**2. Record once** — Claude drives the browser and generates the test:

```bash
ccqa record tasks/create-and-complete
```

**3. Run it** — vitest replays the recording; no LLM involved:

```bash
ccqa run tasks/create-and-complete
```

A `report.json` (+ step screenshots) is always written to `ccqa-report/`.
See [Running specs](./docs/running.md) for flags, CI recipes, and the
report format.

**4. Optional: share results on a hub** — `ccqa serve` starts a small
self-hosted server (or use the bundled `docker-compose.yaml`). Pushing
reports to it gives your team:

- a dashboard of runs, with per-step screenshots
- a browsable inventory of what is tested
  ([perspectives](./docs/spec.md#inventory-coverage-with-perspectives)),
  kept fresh automatically by `record`/`generate`
- triage grading — mark each failure call right or wrong; the hub learns
  from the grades
- one place for shared sessions, variables, and learned prompts — CI
  needs a single secret

```bash
export CCQA_HUB_TOKEN=$(openssl rand -hex 24)
ccqa serve                                  # or: docker compose up -d
ccqa run tasks/create-and-complete --push-report \
  --hub-url http://localhost:8787 --hub-token $CCQA_HUB_TOKEN
```

See [Hub](./docs/hub.md) for the full setup (encryption, container
deployment, HTTP API).

## Documentation

| I want to… | Read |
|---|---|
| Write specs: fields, reusable blocks, file uploads, coverage inventory | [spec.yaml reference](./docs/spec.md) |
| Draft specs interactively with Claude | [Draft](./docs/draft.md) |
| Generate Playwright or runn tests that reuse my existing test code | [Generation targets](./docs/targets.md) |
| Run specs, read reports, triage failures, detect drift, wire up CI | [Running specs](./docs/running.md) |
| Run specs live (no codegen), with per-project guidance | [Live specs](./docs/live.md) |
| Start runs already signed in / skip device-trust gates | [Saved sessions](./docs/sessions.md) |
| See which assertions generated tests use | [Assertions](./docs/assertions.md) |
| Auto-fix failing recorded tests | [Auto-fix](./docs/auto-fix.md) |
| Aggregate results, sessions, and variables on a team server | [Hub](./docs/hub.md) |
| Script the hub over HTTP | [Hub API](./docs/hub-api.md) |
| Understand why ccqa is built this way | [ADR](./docs/adr/README.md) |

## License

MIT
