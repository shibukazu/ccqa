# ccqa

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder and runner. Write a test
spec in YAML; Claude drives the browser once to discover the route; ccqa
compiles the recording into runnable test code for the target of your choice
— its own vitest-based `test.spec.ts`, a plain Playwright spec, or a runn
runbook — and `ccqa run` executes everything into one report you can push to
a shared hub. No extra API key. Just `claude`.

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

- **Deterministic** (the default): record once, replay in CI under vitest —
  no LLM at run time, cheapest and most stable.
- **Live** (`mode: live`): no codegen; Claude drives every run and judges
  each step's `expected` — for fragile, timing-heavy UIs.
- **Other targets** (`target: playwright` / `runn`): the same recording (or
  the spec itself) is emitted as test code that drops into your existing
  suite and runs through your own command.
- Every failing spec gets a root-cause call (TEST_DRIFT / SPEC_CHANGE /
  PRODUCT_BUG) you can grade on the hub — and the hub learns from grades.

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
self-hosted server (a `docker-compose.yaml` ships at the repo root) that
turns pushed reports into a team dashboard: browse runs and screenshots,
grade the failure triage (the hub learns from grades), and store the
saved sessions, variables, and learned prompts that runs pull — CI then
needs a single secret.

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
