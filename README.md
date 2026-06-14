# ccqa

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder. Write a spec in YAML, run `ccqa trace`, and Claude drives your app via [agent-browser](https://github.com/vercel-labs/agent-browser). Every action is recorded and compiled into a deterministic test script you can run in CI. No extra API key. Just `claude`.

[日本語版 README](./docs/README.ja.md)

## How it works

```mermaid
flowchart LR
    A["Write spec\n(spec.yaml)"] --> B["ccqa trace\n(Claude drives browser)"]
    B --> C["ccqa generate\n(LLM → test script)"]
    C --> D["ccqa run\n(deterministic replay)"]
```

`trace` invokes Claude Code with your spec. Claude drives the browser step by step, recording every action as structured data. `generate` compiles that data into a vitest-compatible script. `run` replays it deterministically — no LLM involved.

## Install

```bash
pnpm add -D ccqa vitest agent-browser
```

Requires Node.js **20+**. [agent-browser](https://github.com/vercel-labs/agent-browser) is a peer dependency.

## Quick start

**1. Write a spec** — by hand, or interactively with [`ccqa draft`](./docs/draft.md)

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: Create a task and mark it complete

steps:
  - instruction: |
      Open ${APP_URL}/login. Fill in email and password, submit the form.
    expected: Redirected to /dashboard, user avatar visible in the header

  - instruction: |
      Click "New Task", fill in the title "Fix login bug", set priority to High, save.
    expected: Task appears in the task list with status "Open"
```

URLs live inside `instruction` strings — either verbatim or via `${ENV_VAR}` references for environment-specific values.

**2. Trace** — Claude drives the browser and records every action

```bash
ccqa trace tasks/create-and-complete
```

**3. Generate** — convert recorded actions into a replayable test

```bash
ccqa generate tasks/create-and-complete
```

**4. Run** — replay deterministically, no LLM involved

```bash
ccqa run tasks/create-and-complete
```

By default each run writes step-boundary screenshots and metadata to
`ccqa-report/evidence/<feature>/<spec>/` so a reviewer can confirm a passing
spec actually reached the states its `expected` clauses describe. Disable with
`--no-evidence`.

In CI you can opt in to an HTML run report by passing `--drift-report` — every failing spec gets a drift audit plus a root-cause call (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG) using the PR diff as context, and the report lets a human grade those calls to measure their accuracy. Requires `ANTHROPIC_API_KEY` or a local Claude login for the analysis part. See [Run report](./docs/report.md).

```bash
ccqa run tasks/create-and-complete --drift-report --drift-base origin/main
```

## Features

| Feature | Docs |
|---|---|
| Write specs interactively with Claude | [Draft](./docs/draft.md) |
| Reuse login and other shared step sequences | [Blocks](./docs/blocks.md) |
| Assertion helper functions | [Assertions](./docs/assertions.md) |
| Auto-fix failing tests | [Auto-fix](./docs/auto-fix.md) |
| Detect spec/code drift in CI | [Drift](./docs/drift.md) |
| HTML run report with failure root-cause calls | [Run report](./docs/report.md) |
| Inventory existing test coverage | [Perspectives](./docs/perspectives.md) |
| Architecture decision records (why it is built this way) | [ADR](./docs/adr/README.md) |

## Commands

```
ccqa draft [feature/spec]          Co-author a test spec with Claude
ccqa trace <feature/spec>          Record browser actions for a spec (inlines any included blocks)
ccqa generate <feature/spec>       Generate test script from recorded actions
ccqa run [feature/spec]            Execute generated test scripts (add --drift-report for an HTML report with failure analysis)
ccqa run-nd [target]               Run specs non-deterministically — Claude drives the browser live, judges each step, and saves per-step PNG screenshots (no codegen step)
ccqa drift [feature/spec]          Standalone spec ↔ codebase drift audit (for scheduled jobs)
ccqa perspectives                  Inventory existing test coverage into .ccqa/perspectives.yaml
```

All Claude-driven commands accept `-m, --model <name>` (alias `sonnet` | `opus` | `haiku`, or a full model ID). The flag overrides `CCQA_MODEL`; when both are unset, the Claude Code CLI default is used. They also accept `--language <bcp47>` (e.g. `ja`, `en`) to set the language of human-readable output; the default `auto` follows the language of the spec/codebase. Interactive commands authenticate via your local Claude Code login; commands that talk to Claude in CI (`ccqa run --drift-report`, `ccqa drift`) additionally honor `ANTHROPIC_API_KEY`.

`<feature/spec>` is a 2-segment alias for the on-disk path `.ccqa/features/<feature>/test-cases/<spec>/`.

## File structure

```
.ccqa/
  perspectives.yaml              # Inventory of existing coverage (machine-readable, canonical)
  perspectives.md                # Category index, regenerated from the YAML
  prompts/
    trace.user.md                # Project-specific guidance appended to `ccqa trace`
    run-nd.user.md               # Project-specific guidance appended to `ccqa run-nd`
  blocks/
    login/
      spec.yaml                  # Reusable block (params + steps)
  features/
    tasks/
      perspectives.md            # Per-category detail tables (one per case)
      test-cases/
        create-and-complete/
          spec.yaml              # Test definition
          actions.json           # Recorded actions from trace
          test.spec.ts           # Generated test script
          runs/
            2026-06-14T10-00-00-000Z/  # One run-nd invocation
              run.json                  # Machine-readable summary
              run.md                    # Human-readable per-step log
              steps/
                step-01.before.png      # Before-step screenshot
                step-01.after.png       # After-step screenshot
                step-01.log.txt         # Claude's full transcript for the step
```

Add `.ccqa/features/*/test-cases/*/runs/` to `.gitignore` — these are per-run artefacts that should not be committed.

## Non-deterministic mode (`ccqa run-nd`)

`run-nd` is the live counterpart to the trace → generate → run pipeline. It skips codegen entirely: Claude executes each spec step against `agent-browser` directly, judges whether the step's `expected` outcome holds, and saves a PNG screenshot before and after every step. Use it when:

- you want to validate a spec but don't yet need a replayable, recorded test
- the codegen output for a spec is fragile (heavily timing-dependent UIs, rich-text editors, dynamic selectors)
- you want a visual audit trail of what the page looked like at every step

```
# Run a single spec
ccqa run-nd tasks/create-and-complete

# Run every spec under a feature
ccqa run-nd tasks

# Run every spec in the project, into a unified HTML report
ccqa run-nd --report-dir ccqa-report

# Retry each failing step up to 2 more times
ccqa run-nd --retry 2 tasks/create-and-complete
```

Constraints on selectors / `agent-browser` subcommands that apply during `ccqa trace` (no `eval`, no `@ref`, no bare-tag positional `find`, no chained agent-browser calls) are **relaxed** in `run-nd` — Claude can use any subcommand and any selector style because there is no replay contract to honour.

### Per-project guidance (`.ccqa/prompts/run-nd.user.md`)

ccqa's `run-nd` system prompt is deliberately product-agnostic. Anything specific to **your** project — staging URLs, login flow quirks, rich-editor types, common access-denied wording — belongs in `.ccqa/prompts/run-nd.user.md`. The file is read once per invocation and appended to the system prompt under a "Project-specific guidance" heading.

Keep it short. A page or two of focused notes beats a long handbook — Claude has the spec's `expected` text to work from, the file is for the *non-obvious* product knowledge that isn't in any single spec. Examples of what's useful here:

- "the rich text editor is `[contenteditable='true']` — use `fill`, not keystrokes"
- "login redirects through an IDP service-selection screen; you can skip it by opening the destination URL directly"
- "access-denied is signalled by a specific in-app message string — name it here so the model asserts on it"

Examples of what does **not** belong:

- per-spec details (those belong in the spec's `instruction` / `expected`)
- restating the STEP_RESULT contract (already in the system prompt)
- copy-pasted style guidelines from `trace.user.md` (the relaxed-constraint mode doesn't need them)

The file is capped at 32 KiB; anything beyond that is truncated with a warning.

## License

MIT
