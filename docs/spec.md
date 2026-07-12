# spec.yaml reference

A **spec** is one test case, written as YAML. Specs live at:

```
.ccqa/features/<feature>/test-cases/<spec>/spec.yaml
```

Every CLI command addresses a spec by the 2-segment alias
`<feature>/<spec>` (e.g. `ccqa record tasks/create-and-complete`).

Parsing is **strict**: unknown keys anywhere in the file are rejected, so a
typo fails fast instead of being silently ignored.

`ccqa init` scaffolds the skeleton (`.ccqa/features/`, `.ccqa/blocks/`). A
spec directory accumulates these files as you work:

```
.ccqa/
  config.yaml                    # generation-target settings (see targets.md)
  blocks/
    login/spec.yaml              # reusable block (params + steps)
  features/
    tasks/
      test-cases/
        create-and-complete/
          spec.yaml              # this document's subject
          ir.json                # (recording targets) recorded actions
          test.spec.ts           # (agent-browser, deterministic) generated test
          generated.json         # (other targets) manifest of generated files
          runs/<timestamp>/      # (live) one run's step screenshots + summary
```

Gitignore the per-run artefacts: `.ccqa/features/*/test-cases/*/runs/` and
`ccqa-report*/`.

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `title` | yes | Human-readable test title. |
| `steps` | yes | At least one step (action or `include`). |
| `target` | no | Generation-target plugin. Defaults to `defaultTarget` in `.ccqa/config.yaml`, then `agent-browser`. See [Generation targets](./targets.md). |
| `mode` | no | `deterministic` (default) or `live`. agent-browser only. |
| `session` | no | Saved session name(s) to restore before step 1. agent-browser `mode: live` only. See [Saved sessions](./sessions.md). |
| `relatedPaths` | no | Glob list of source paths this spec depends on. |

`mode:` and `session:` only apply to the `agent-browser` target. Setting
either on a spec whose `target:` resolves to anything else is a validation
error ("only applies to the agent-browser target — remove it or drop
`target: ...`").

## Steps

An **action step** is an `instruction` / `expected` pair, both required and
non-empty:

```yaml
title: Create a task and mark it complete
mode: deterministic   # or: live. Omit for deterministic (the default).

steps:
  - instruction: |
      Open ${APP_URL}/login. Fill in email and password, submit the form.
    expected: Redirected to /dashboard, user avatar visible in the header

  - instruction: |
      Click "New Task", fill in the title "Fix login bug", save.
    expected: Task appears in the task list with status "Open"
```

- URLs live inside `instruction` strings — verbatim, or via `${ENV_VAR}`
  references for environment-specific values. `${VAR}` resolves against the
  process environment at run time; see
  [Profiles and environment variables](./running.md#profiles-and-environment-variables)
  for how profiles supply those values per environment.
- Write `expected` against concrete, observable signals (visible text, URL
  pattern, element state). Avoid timestamps, exact counts, and
  session-specific values — they are not stable across runs.
  [`ccqa draft`](./draft.md) reviews each step for exactly this.

## Blocks — reusable step templates

A **block** is a named sequence of step declarations that any spec pulls in
via an `include` step. Use blocks to share login flows or other setup
repeated across specs.

A block is a pure **spec template**: there is no per-block recording or test
artifact. When a spec includes a block, the block's steps are inlined into
the spec's own step list at trace time, and the spec drives the full run
(block steps + spec steps) from scratch. Each spec's test stays
self-contained, avoiding "the block recording was right for spec A but wrong
for spec B".

### Writing a block

```yaml
# .ccqa/blocks/login/spec.yaml
title: ID provider login
params:
  - name: loginUrl
    required: true
  - name: email
    required: true
  - name: password
    required: true
    secret: true

steps:
  - instruction: open ${loginUrl}
    expected: email input is visible

  - instruction: |
      Fill [placeholder='email'] with ${email}.
      Fill [type='password'] with ${password}.
      Click the login button.
    expected: redirected to the post-login page
```

Rules:

- A block's `steps` must be action steps only. Nested blocks (`include`
  inside a block) are rejected: flatten by inlining the included block's
  steps.
- `params` are string-typed; reference them in step strings with `${name}`.
  Each param takes `name` (required), `required` (defaults to `true`),
  `secret` (defaults to `false`), and optional `dummy` / `description`
  fields used by the draft/drift prompts.
- `secret: true` marks a value as sensitive. Generated code renders env-like
  values as `process.env.<NAME>` template literals, so secrets never land in
  the generated test file.

### Using a block from a spec

```yaml
steps:
  - include: login
    params:
      loginUrl: ${APP_LOGIN_URL}
      email: ${APP_EMAIL}
      password: ${APP_PASSWORD}

  - instruction: open ${APP_URL}/tasks
    expected: task list is visible
```

`${paramName}` references inside the block are substituted with the values
the include site provides. Unresolved `${ENV_VAR}` references flow through
unchanged so the run-time `process.env` lookup can fill them in. Passing an
unknown param, or omitting a required one, is an error at expand time.

In the generated test the block content is inlined and tagged with
`// step: step-XX [<block name>]` comments, so you can still see which step
came from which block.

### Editing a block

1. Update `.ccqa/blocks/<name>/spec.yaml`.
2. Re-run `ccqa record <feature>/<spec>` for every spec that includes it.

A block change costs one re-record per including spec, but each trace runs
end-to-end, so a block step that fails under a particular spec is caught
immediately, not at that spec's run time.

`ccqa record` warns when it finds stale artifacts from older versions
(`test.spec.ts` / `actions.json` under a block directory) — delete them
manually; blocks no longer carry recordings.

## relatedPaths

`relatedPaths` is a list of glob patterns naming the source files the spec
depends on:

```yaml
relatedPaths:
  - src/features/tasks/**
  - src/app/tasks/page.tsx
```

Both `ccqa draft` (provisional) and `ccqa record` (refined from real browser
observations) maintain this list, so you rarely write it by hand. Commit it
alongside the spec. It scopes `ccqa run --changed` / `ccqa drift --changed`
and the failure-analysis diff — see
[Scoping with --changed](./running.md#scoping-with---changed-and-relatedpaths).

## File uploads

`<input type="file">` opens the OS file picker when clicked, and no
Playwright-style automation can drive that dialog. ccqa instead sets the
input's files via the browser API: write the upload step in plain language,
and `ccqa record` captures it as a structured `upload` action
(`abUpload(...)` in generated agent-browser tests).

Put test files under `.ccqa/fixtures/` (a convention, not enforced) and
reference them through the `CCQA_FIXTURES_DIR` environment variable you set
yourself, so the same spec string resolves on dev laptops and CI alike:

```bash
export CCQA_FIXTURES_DIR="$(pwd)/.ccqa/fixtures"
```

```yaml
- instruction: |
    Upload ${CCQA_FIXTURES_DIR}/profile-avatar.png via the avatar file
    input (the input has aria-label "Profile avatar").
  expected: The uploaded image preview appears next to the file input.
```

The phrasing tells Claude *which* element is the file input (by aria-label,
test id, or another state-independent attribute) and *which* fixture to
attach.

- **Multi-file inputs**: name several paths in one step; a single `upload`
  action with all files is recorded (`abUpload(selector, file1, file2)`).
- Generated `abUpload` resolves each relative path against the test's
  working directory and verifies the file exists before calling
  `agent-browser upload`, so a missing fixture is a clear ccqa error.
- **Do not** write a step that clicks the file input — that opens the OS
  picker. Do not bake absolute paths into specs; use `${CCQA_FIXTURES_DIR}`.
- Live (`mode: live`) specs use the same convention; the live prompt tells
  Claude to use `agent-browser upload` and `${CCQA_FIXTURES_DIR}`.

## Authoring workflow

### Draft specs with Claude

[`ccqa draft`](./draft.md) co-authors a spec interactively: you describe the
intent, Claude reads the codebase, proposes the YAML, and reviews each step
for assertability, block references, step granularity, and unimplemented
behavior.

### Inventory coverage with perspectives

`ccqa perspectives` inventories the coverage that already exists under
`.ccqa/` — the equivalent of a hand-kept QA spreadsheet, deliberately scoped
to *facts about what is tested today*. The document lives **on the hub
only** (one per project) and is browsed in the hub UI's *Perspectives* view;
nothing is written into the repo. The command therefore needs a hub
connection (`CCQA_HUB_URL` / `CCQA_HUB_TOKEN`, or `--hub-url` /
`--hub-token`).

```bash
ccqa perspectives                          # regenerate the inventory and push it
ccqa perspectives --instruction "..."      # steer how summaries are written
ccqa perspectives --apply                  # skip the [y/N] confirmation
ccqa perspectives --language en            # English descriptive fields
```

The inventory also stays fresh without running the command: a successful
`ccqa record` / `ccqa generate` automatically upserts that one spec's entry
(when a hub is configured). The full command remains the way to build the
document the first time and to prune entries for specs that were deleted.
Earlier ccqa versions wrote `.ccqa/perspectives.yaml` / `.md` files into the
repo; the command deletes those leftovers when it runs.

How each case is assembled:

- `title` and `relatedPaths` are transcribed verbatim from `spec.yaml`.
- `status` is mechanically derived by the CLI, never written by Claude:
  `traced` = `ir.json` exists, `generated` = `test.spec.ts` exists. For
  `mode: live` specs these carry no completeness meaning (live skips
  codegen).
- `summary` / `startScreen` / `testCondition` / `preconditions` are written
  by Claude from the spec's steps, with read-only tools.
- `note` is **human-only**, edited in the hub UI's Perspectives view, and
  preserved across regeneration, matched by `(featureName, specName)`.

Two things are intentionally out of scope (and rejected by the strict
schema): severity/priority fields, and code-vs-test gap analysis. See
[ADR-0003](./adr/0003-perspectives-factual-inventory.md) for the rationale.
