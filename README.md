# ccqa

**Your Claude subscription already includes a QA engineer.**

ccqa turns Claude Code into a browser test recorder. Write a spec in YAML, declare in the spec whether it should run **deterministic** or **live**, then `ccqa run` does the right thing per spec:

- **Deterministic** (`mode: deterministic`, default): record once with `ccqa record`. Claude drives the browser, ccqa compiles every action into a `test.spec.ts` you can replay in CI under vitest — no LLM at run time. Cheapest and most stable.
- **Live** (`mode: live`): no codegen. `ccqa run` sends each step to Claude every time, Claude drives `agent-browser` directly, judges pass/fail against the step's `expected`, and saves a before/after screenshot. More flexible for fragile UIs.

A single project mixes both: each spec.yaml picks its own mode, and `ccqa run` reads the field and dispatches. The HTML report covers both in one page.

No extra API key. Just `claude`.

[日本語版 README](./docs/README.ja.md)

## How it works

```mermaid
flowchart LR
    A["Write spec\n(spec.yaml + mode:)"] --> B{mode}
    B -- deterministic --> C["ccqa record\n(Claude → test.spec.ts)"]
    C --> D["ccqa run\n(vitest replay, no LLM)"]
    B -- live --> E["ccqa run\n(Claude drives every time,\nper-step pass/fail)"]
```

For deterministic specs, `record` invokes Claude Code with your spec, Claude drives the browser step by step, every action is recorded, and a vitest-compatible script is generated. `run` then replays it without involving an LLM.

For live specs, `record` is not needed. `run` directly sends each step to Claude, which drives the browser through `agent-browser`, judges whether the step's `expected` clause holds, and writes a PNG before and after each step. Useful when codegen is fragile (timing-dependent UIs, rich-text editors, dynamic selectors).

## Install

```bash
pnpm add -D ccqa vitest agent-browser
```

Requires Node.js **20+**. [agent-browser](https://github.com/vercel-labs/agent-browser) is a peer dependency.

## Quick start

**1. Write a spec** — by hand, or interactively with [`ccqa draft`](./docs/draft.md). Declare the mode in the spec itself.

```yaml
# .ccqa/features/tasks/test-cases/create-and-complete/spec.yaml
title: Create a task and mark it complete
mode: deterministic   # or: live. Omit for deterministic (the default).

steps:
  - instruction: |
      Open ${APP_URL}/login. Fill in email and password, submit the form.
    expected: Redirected to /dashboard, user avatar visible in the header

  - instruction: |
      Click "New Task", fill in the title "Fix login bug", set priority to High, save.
    expected: Task appears in the task list with status "Open"
```

URLs live inside `instruction` strings — either verbatim or via `${ENV_VAR}` references for environment-specific values.

**2a. For `mode: deterministic` — record once, then replay**

```bash
ccqa record tasks/create-and-complete   # Claude drives the browser; generates test.spec.ts
ccqa run tasks/create-and-complete      # vitest replays test.spec.ts; no LLM
```

**2b. For `mode: live` — skip codegen, run directly**

```bash
ccqa run tasks/create-and-complete      # Claude drives the browser every time
```

Live specs can start already-signed-in by pointing `statePath:` at a saved agent-browser state file (cookies + localStorage). Run an interactive login locally once, save the state with `agent-browser state save .ccqa/sessions/<name>.json`, then commit the path (not the file) — see [Pre-authenticated state](#pre-authenticated-state-statepath) below for the local bootstrap and the CI restore pattern.

By default deterministic runs write step-boundary screenshots and metadata to `ccqa-report/evidence/<feature>/<spec>/` so a reviewer can confirm a passing spec actually reached the states its `expected` clauses describe. Disable with `--no-evidence`.

In CI you can opt in to an HTML run report by passing `--report` — every failing spec gets a drift audit plus a root-cause call (TEST_DRIFT / SPEC_CHANGE / PRODUCT_BUG) using the branch's git diff as context, and the report lets a human grade those calls to measure their accuracy. Requires `ANTHROPIC_API_KEY` or a local Claude login for the analysis part. Opt out with `--no-failure-analysis` (which also implicitly skips the drift audit — the audit is rendered as evidence under the classification, so without the classification the cost has nowhere to land). Use `--no-drift-audit` to keep the classification but skip the audit. See [Run report](./docs/report.md).

```bash
ccqa run tasks/create-and-complete --report --base origin/main
ccqa run --changed --report                    # only specs whose relatedPaths touch the diff
```

## Features

| Feature | Docs |
|---|---|
| Write specs interactively with Claude | [Draft](./docs/draft.md) |
| Reuse login and other shared step sequences | [Blocks](./docs/blocks.md) |
| Drive `<input type="file">` without an OS picker | [File upload](./docs/file-upload.md) |
| Assertion helper functions | [Assertions](./docs/assertions.md) |
| Auto-fix failing tests | [Auto-fix](./docs/auto-fix.md) |
| Detect spec/code drift in CI | [Drift](./docs/drift.md) |
| HTML run report with failure root-cause calls | [Run report](./docs/report.md) |
| Inventory existing test coverage | [Perspectives](./docs/perspectives.md) |
| Architecture decision records (why it is built this way) | [ADR](./docs/adr/README.md) |

## Commands

```
ccqa init                          Scaffold .ccqa/prompts/{live,record}.{user,agent}.md templates
ccqa draft [feature/spec]          Co-author a test spec with Claude
ccqa perspectives                  Inventory existing test coverage into .ccqa/perspectives.yaml
ccqa record <feature/spec>         (deterministic specs only) Trace browser actions + generate test.spec.ts
ccqa run [feature/spec...]         Execute specs. Per spec, the spec.yaml `mode:` field selects deterministic
                                   (vitest replay) or live (Claude drives every time). One run can mix both;
                                   `--report` writes one unified HTML. Pass multiple targets space-separated.
ccqa drift [feature/spec]          Standalone spec ↔ codebase static audit (for PR checks)
```

`ccqa run` flags:

- `--report [dir]` — write a self-contained HTML run report (default dir: `ccqa-report/`)
- `--profile <name>` — load `.ccqa/profiles/<name>.env` into the environment before resolving spec `${VAR}` references, so one spec targets dev/stg/prd without per-environment copies. See [Profiles](#profiles---profile).
- `--changed` — restrict execution to specs whose `relatedPaths` intersect `git diff <base>...HEAD`. Mutually exclusive with explicit spec targets.
- `--concurrency <n>` — run up to N specs in parallel **within each mode** (deterministic specs run as one phase, live specs as the next; parallelism is within a phase, not across). Default `1` (sequential, identical to before). Above 1, each spec's output is buffered and flushed as a labelled block so parallel logs stay legible. Live specs each launch their own headed Chrome, so high values spawn many browser instances.
- `--base <ref>` — base ref for the git diff (default: `$GITHUB_BASE_REF`, then `origin/main`)
- `--no-failure-analysis` — skip the per-failure root-cause classification (also skips the drift audit, since the audit only shows under the classification)
- `--no-drift-audit` — skip the spec ↔ code drift audit while keeping the classification
- `--no-evidence` — (deterministic specs only) skip step-boundary PNG capture
- `--retry <n>` — (live specs only) retry each failing step up to N more times
- `--format <fmt>` — `text` (default), `json` (report.json), `github` (Actions annotations)
- `--out <dir>` — (live specs only, single-spec invocations) override the per-run artifact directory
- `--update-agent-prompt` — (live specs only) after the run, summarise it back to Claude and rewrite `.ccqa/prompts/live.agent.md` so the next run inherits the lessons learned. `ccqa record` ships the same flag, refreshing `record.agent.md` from the trace summary.

All Claude-driven commands accept `-m, --model <name>` (alias `sonnet` | `opus` | `haiku`, or a full model ID). The flag overrides `CCQA_MODEL`; when both are unset, the Claude Code CLI default is used. They also accept `--language <bcp47>` (e.g. `ja`, `en`) to set the language of human-readable output; the default `auto` follows the language of the spec/codebase. `--cwd <path>` works on `record` / `run` / `drift` so you can target a subpackage inside a monorepo from the repo root. Interactive commands authenticate via your local Claude Code login; commands that talk to Claude in CI (`ccqa run --report`, `ccqa drift`) additionally honor `ANTHROPIC_API_KEY`.

`<feature/spec>` is a 2-segment alias for the on-disk path `.ccqa/features/<feature>/test-cases/<spec>/`. `ccqa run` accepts several targets space-separated (each a `<feature>/<spec>`, a bare `<feature>` for all its specs, or omitted for everything); duplicates are de-duped and `--changed` cannot be combined with explicit targets.

## File structure

```
.ccqa/
  perspectives.yaml              # Inventory of existing coverage (machine-readable, canonical)
  perspectives.md                # Category index, regenerated from the YAML
  profiles/                      # `--profile <name>` env files
    stg.env                      # URLs + credential refs; commit if it uses secret-manager refs, gitignore if it holds plaintext secrets
    prd.env
  prompts/                       # Run `ccqa init` to scaffold these
    record.user.md               # Human-maintained guidance appended to `ccqa record` (trace phase)
    record.agent.md              # Auto-updated by `ccqa record --update-agent-prompt`
    live.user.md                 # Human-maintained guidance appended to `ccqa run` (live specs)
    live.agent.md                # Auto-updated by `ccqa run --update-agent-prompt`
  blocks/
    login/
      spec.yaml                  # Reusable block (params + steps)
  features/
    tasks/
      perspectives.md            # Per-category detail tables (one per case)
      test-cases/
        create-and-complete/
          spec.yaml              # Test definition, with `mode: deterministic | live`
          actions.json           # (deterministic only) Recorded actions from `ccqa record`
          test.spec.ts           # (deterministic only) Generated vitest script
          runs/
            2026-06-14T10-00-00-000Z/  # (live only) one `ccqa run` invocation
              run.json                  # Machine-readable summary
              run.md                    # Human-readable per-step log
              steps/
                step-01.before.png      # Before-step screenshot
                step-01.after.png       # After-step screenshot
                step-01.log.txt         # Claude's full transcript for the step
```

Add `.ccqa/features/*/test-cases/*/runs/` to `.gitignore` — these are per-run artefacts that should not be committed. Likewise `ccqa-report*/`.

## Profiles (`--profile`)

Environment-specific values (base URLs, the login URL, the test account) differ between dev/stg/prd. Keep them out of the spec as `${VAR}` references and supply them from a **profile** — a `.env` file under `.ccqa/profiles/<name>.env`. `ccqa run --profile <name>` (and `ccqa record`) merges it into the environment before resolving `${VAR}`, so one spec runs against any environment.

```yaml
# spec.yaml — environment-agnostic
steps:
  - include: login
    params:
      loginUrl: ${ID_PROVIDER_URL}
      email: ${TEST_USER_EMAIL}
  - instruction: Open ${APP_BASE_URL}/dashboard
    expected: The dashboard renders
```

```bash
# .ccqa/profiles/stg.env
APP_BASE_URL=https://app-stg.example.com
ID_PROVIDER_URL=https://id-stg.example.com/
TEST_USER_EMAIL=stg-tester@example.com
TEST_USER_PASSWORD=...
```

```bash
ccqa run auth/login --profile stg    # same spec, stg values
ccqa run auth/login --profile prd    # same spec, prd values
```

- **Name** is free-form (`stg`/`prd` are just conventions); it maps to `.ccqa/profiles/<name>.env`. Path separators / `..` / a leading dot are rejected. A missing or mistyped profile fails fast (exit 2). The name is logged; values never are.
- **Format** is a small `.env` subset: `KEY=value`, `#` comments, optional `export`, quoted values. Profile values **override** the inherited environment.
- **No `--profile`?** ccqa auto-loads `<cwd>/.env` if it exists (like dotenv/Next.js). No `.env` and no flag → `${VAR}` resolves against the existing `process.env` (e.g. via `direnv`), exactly as before.

### Secrets

If you store literal secrets in a profile, **gitignore it** (e.g. `/.ccqa/profiles/*.env`).

To keep plaintext off disk, put a secret-manager reference in the value and let an external tool resolve it before ccqa runs. **ccqa does not resolve `op://` (or any reference) itself** — it just merges the file into `process.env` verbatim. You wrap the run in the secret manager's own command, which substitutes the real values and hands them to ccqa as ordinary env vars. The whole profile is then committable, and one command works both locally and in CI ([1Password](https://developer.1password.com/docs/cli/secrets-environment-variables/) shown; Vault / SOPS work the same):

```bash
# .ccqa/profiles/stg.env — references only, committable
TEST_USER_PASSWORD=op://<vault>/<item>/password

op run --env-file=.ccqa/profiles/stg.env -- ccqa run auth/login
```

Here `op` resolves the references and injects the real values into the environment, so you **drop `--profile`** — ccqa reads the already-resolved values from `process.env`. (Passing `--profile stg` instead would merge the literal `op://…` strings unresolved, and login would fail.) In CI, authenticate `op` with a [service-account token](https://developer.1password.com/docs/service-accounts/) — then that token is the only CI secret.

## Live specs (`mode: live`)

For specs declared `mode: live` in their spec.yaml, `ccqa run` skips codegen entirely: Claude executes each spec step against `agent-browser` directly, judges whether the step's `expected` outcome holds, and saves a PNG screenshot before and after every step. Use this mode when:

- you want to validate a spec but don't yet need a replayable, recorded test
- the codegen output for a spec is fragile (heavily timing-dependent UIs, rich-text editors, dynamic selectors)
- you want a visual audit trail of what the page looked like at every step

```bash
# Run a single live spec
ccqa run tasks/create-and-complete

# Run every spec under a feature (mixes deterministic + live as declared)
ccqa run tasks

# Run every spec in the project, into a unified HTML report
ccqa run --report

# Retry each failing step up to 2 more times (live specs only)
ccqa run --retry 2 tasks/create-and-complete
```

Constraints on selectors / `agent-browser` subcommands that apply during `ccqa record` (no `eval`, no `@ref`, no bare-tag positional `find`, no chained agent-browser calls) are **relaxed** for live specs — Claude can use any subcommand and any selector style because there is no replay contract to honour.

### Pre-authenticated state (`statePath:`)

By default each `ccqa run` of a live spec spins up a fresh `agent-browser` session and starts signed-out. That keeps runs hermetic but forces every device-trust gate (Slack "we don't recognize this browser", Google's unfamiliar-device prompt, MFA challenges, …) to fire on every run.

To skip them, save an authenticated browser state to a JSON file once locally and point the spec at it:

```yaml
title: Slack App Home — non-admin access denied
mode: live
statePath: .ccqa/sessions/slack-stg.json   # cookies + localStorage to restore
steps:
  - ...
```

ccqa resolves the path against the project root and passes `--state <path>` to every `agent-browser` invocation in the run (including ccqa's own screenshot calls). The file is **read-only** — `--state` loads it but never writes back to it. Re-running locally or in CI does not mutate it.

Bootstrap once locally:

```bash
# 1. Log in interactively in a headed browser.
agent-browser --headed open https://app.slack.com
# …complete login + device-trust prompts by hand…

# 2. Snapshot cookies + localStorage to the path the spec references.
mkdir -p .ccqa/sessions
agent-browser state save .ccqa/sessions/slack-stg.json
agent-browser close

# 3. ccqa run reuses the saved state — no login prompt.
ccqa run slack/app-home-non-admin-access-denied
```

Add `.ccqa/sessions/` to `.gitignore` — these files contain live auth cookies and must never be committed.

#### CI: bring the state file with you

`statePath:` lives entirely inside `.ccqa/` and never touches `~/`. CI re-uses the state by writing the file into the same path the spec already references:

```bash
# Locally, after the interactive bootstrap above:
base64 -i .ccqa/sessions/slack-stg.json | pbcopy
# paste into your CI secret store as CCQA_SLACK_STG_STATE_B64
```

```yaml
# .github/workflows/ccqa.yml (sketch)
- name: Restore agent-browser state
  env:
    CCQA_SLACK_STG_STATE_B64: ${{ secrets.CCQA_SLACK_STG_STATE_B64 }}
  run: |
    mkdir -p .ccqa/sessions
    printf '%s' "$CCQA_SLACK_STG_STATE_B64" | base64 -d \
      > .ccqa/sessions/slack-stg.json

- name: Run live specs
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: pnpm ccqa run --report
```

Caveats:

- **Expiry.** Whatever the upstream service's "remember this device" window is (Slack ≈ 30 days, others vary), the cookies in the state file eventually expire and CI starts failing on the device-trust gate again. Re-bootstrap locally and rotate the secret.
- **Treat the file as a credential.** It contains live auth cookies. Store it in your CI secret manager (GitHub Actions encrypted secrets, Vault, …) and never commit it.
- **Deterministic specs ignore `statePath:`.** Today it only affects `mode: live`; vitest-replayed specs always run isolated.

### Per-project guidance (`.ccqa/prompts/live.user.md` + `live.agent.md`)

ccqa's live-mode system prompt is deliberately product-agnostic. Anything specific to **your** project — staging URLs, login flow quirks, rich-editor types, common access-denied wording — belongs in two sibling files (run `ccqa init` to scaffold both):

- `.ccqa/prompts/live.user.md` — human-maintained stable guidance.
- `.ccqa/prompts/live.agent.md` — auto-updated by `ccqa run --update-agent-prompt` from each run's summary. You can hand-edit it, but the next `--update-agent-prompt` run may rewrite the whole file; durable rules should live in `live.user.md`.

Both files (when present) are read once per invocation and appended to the system prompt under "Project-specific guidance". The `ccqa record` (trace) side has the same split: `record.user.md` + `record.agent.md`, refreshed by `ccqa record --update-agent-prompt`.

Keep them short. A page or two of focused notes beats a long handbook — Claude has the spec's `expected` text to work from, these files are for the *non-obvious* product knowledge that isn't in any single spec. Examples of what's useful here:

- "the rich text editor is `[contenteditable='true']` — use `fill`, not keystrokes"
- "login redirects through an IDP service-selection screen; you can skip it by opening the destination URL directly"
- "access-denied is signalled by a specific in-app message string — name it here so the model asserts on it"

Examples of what does **not** belong:

- per-spec details (those belong in the spec's `instruction` / `expected`)
- restating the STEP_RESULT contract (already in the system prompt)
- copy-pasted style guidelines from `record.user.md` (the relaxed-constraint mode doesn't need them)

The combined bundle is capped at 32 KiB; anything beyond that is truncated with a warning.

## License

MIT
