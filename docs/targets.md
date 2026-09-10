# Generation targets

A spec's `target:` field picks which plugin turns it into runnable test
code. Omit it and ccqa uses `defaultTarget` from `.ccqa/config.yaml`,
falling back to `agent-browser` when there is no config file at all — a
project that never mentions targets keeps working unchanged.

```yaml
title: Create a task and mark it complete
target: playwright   # omit for agent-browser (the default)
steps:
  - instruction: ...
    expected: ...
```

## The built-in targets

| Target | Input | What `record` / `generate` produce | How `ccqa run` executes it |
|---|---|---|---|
| `agent-browser` (default) | recording | ccqa mechanically compiles the recording into `test.spec.ts` (vitest) | vitest replay (`mode: deterministic`) or Claude live per step (`mode: live`) |
| `playwright` | recording | The same recording, mechanically compiled into a plain `@playwright/test` spec; when the target's `resources` are configured, an LLM pass then rewrites the draft to reuse your existing page objects/helpers | via the target's configured `runCommand` |
| `runn` | spec | No recording step — `ccqa generate` asks Claude to write a [runn](https://github.com/k1LoW/runn) runbook (YAML, validated to parse) directly from the spec, reading the backend sources with Read/Grep/Glob | via the target's configured `runCommand` |

`mode:` and `session:` are agent-browser-only fields; setting them on a spec
whose `target:` resolves to anything else is a validation error.

## `record` vs `generate`

Recording-backed targets (`agent-browser`, `playwright`) need `ccqa record`
once: Claude drives the browser to discover the route, and the actions are
traced into `ir.json` — a tool-neutral intermediate representation shared by
every recording-backed target — which is then handed to the target's
generate step. Spec-input targets (`runn`) have no recording step; `ccqa
generate` is where generation starts.

```bash
ccqa record tasks/create-and-complete     # recording targets: trace + generate
ccqa generate api/create-task             # spec-input targets: generate only
ccqa generate tasks/create-and-complete   # recording targets: re-run generate
                                          # from the saved ir.json
```

- Running `ccqa record` on a spec-input target exits 2 with a pointer to
  `ccqa generate`. Running `ccqa generate` on a recording target with no
  `ir.json` errors with "Run `ccqa record` first".
- Both commands share the codegen flags: `--auto-fix
  <interactive|auto|skip>` (default `interactive`) and `--auto-fix-max-retries
  <n>` (default 3) — see [Auto-fix](./auto-fix.md) — plus `-m/--model`,
  `--language`, `--cwd`, `--hub-profile`, and the hub connection flags.
- To regenerate from an existing `ir.json` without re-recording, run `ccqa
  generate` — `ccqa record` always traces. `--overwrite` replaces an existing
  test without prompting and `--no-replay` skips the route check, see
  [Regenerating from a saved route](#regenerating-from-a-saved-route).
- `ccqa record` also accepts `--trace-only` (stop after the trace),
  `--trace-validation <lenient|strict>`, and `--learn-hub-trace-prompt` (refresh
  the hub-stored `record.agent` learning notes after the trace).

> **Breaking change:** recordings used to be stored as `actions.json`; they
> are now `ir.json`. There is no migration — re-run `ccqa record` for any
> spec recorded before the change.

## `.ccqa/config.yaml`

Targets are configured project-wide. The file is validated strictly — an
unknown key or an unregistered target name is an error.

```yaml
defaultTarget: playwright   # used when a spec has no target: (default: agent-browser)

targets:
  playwright:
    # where this target's generated test lands; omit for the spec's own directory
    testPath: e2e/specs/{feature}/{spec}.spec.ts
    # optional; enables `ccqa run`. {artifactsDir} collects traces into the report.
    runCommand: "pnpm exec playwright test --trace retain-on-failure --output {artifactsDir} {files}"

    # Existing code the generated test should import instead of duplicating.
    resources:
      - path: e2e/pages
        description: page objects, one per screen
      - path: e2e/steps
        description: shared multi-screen helpers (e.g. login)
      - package: "@your-org/e2e-kit"
        description: shared fixtures and selectors published as a package

    # Style guidance for the generation prompt (not imported as code).
    conventions:
      guides: [docs/e2e-guidelines.md]
      examples: [e2e/specs/sample_login.spec.ts]

  runn:
    testPath: runbooks/{feature}/{spec}.yaml
    runCommand: "runn run --verbose --capture {artifactsDir} {files}"
```

### `resources` — code the generated test reuses

Each entry has exactly one of `path` (code inside this repo — a literal path
or a glob) or `package` (an installed npm package, imported by name), plus
an optional `description`. Either form works for page objects, step helpers,
fixtures, shared constants, or any other export the generated code can
reuse.

Generation is **reuse-first**: the mechanical compile always runs, and the
LLM rewrite pass runs only when `resources` is non-empty. The rewrite treats
the mechanical draft as recorded ground truth and only restructures it to
import your existing code instead of duplicating it. With no `resources`,
the draft ships as-is — no LLM involved for the playwright target.

### `conventions` — style guidance

`conventions` are prompt inputs, not imports: `guides` are convention
documents and `examples` are existing tests whose style the generated code
should imitate. Entries may be globs.

### `testPath` — where the generated test lands

`testPath` is a template, expanded per spec:

| Placeholder | Expands to |
|---|---|
| `{feature}` | the feature directory name |
| `{spec}` | the test-case directory name |

Omit it and the test lands in the spec's own directory
(`.ccqa/features/<feature>/test-cases/<spec>/test.spec.ts`, or `runbook.yaml`
for runn) — the same convention as the agent-browser target, so every spec
carries its runnable test next to its `spec.yaml`. Set it to write into your
repo's own test tree instead.

The path is **derived, not recorded**: `ccqa run`, the drift audit, failure
triage and `ccqa perspectives` all expand the same template rather than reading
a manifest, so they find a spec's test whether or not it has been generated
yet. Generation is held to it too — the LLM rewrite pass may restructure the
test, but it cannot decide where the test lives. Support files it creates
(page objects and the like) go under a `resources` path root or beside the
test; those belong to your repo's layout, not to ccqa.

The template must be relative to the project root, must not contain `..`, and
must contain `{spec}` — without it every spec would generate onto one file.
`testPath` is not configurable for the `agent-browser` target: `ccqa run`
enumerates its vitest tests in the spec directory, so a configurable path there
would be read by the audit and ignored by the runner.

Whatever a generated test imports from inside the project — page objects, step
helpers, shared constants — is part of the test case as far as the audit and
failure triage are concerned. They follow the test's imports (relative
specifiers and `tsconfig.json` `paths` aliases, including a relative `extends`
chain, three hops deep, never into `node_modules`), so a selector living in a
page object is audited alongside the one in the test.

> **Breaking change:** `outDir` and the per-spec `generated.json` manifest are
> gone. Set `testPath` (or accept the spec-directory default) and delete any
> `generated.json` left in your spec directories — see
> [ADR-0028](./adr/0028-a-derived-test-path-and-a-recorded-route.md).

### Regenerating from a saved route

`ccqa generate` recompiles `ir.json` without a browser or a trace, which is how
a whole suite is re-emitted after a page object or a convention changes. One
thing makes that pointless, and it is refused rather than warned about: **the
recorded route no longer replays.** ccqa replays the saved actions once against
a fresh browser session — the same post-trace validation `record` runs, no
model involved — and refuses when the route is gone, since re-emitting a dead
route can only produce a test that cannot pass. `--no-replay` skips the check
for environments with no browser or no variables. It does not run under `ccqa
record`, which has just recorded and validated the route it is compiling.

An existing generated test is replaced only after a y/N prompt (`--overwrite`
skips it; a non-TTY declines). ccqa does not claim to know whether that file
was hand-edited: answering it needs a record of what the last generation wrote,
and this design deliberately keeps none — see
[ADR-0028](./adr/0028-a-derived-test-path-and-a-recorded-route.md).

### The recorded route, and what a re-record changed

`ir.json` is the record of the route a recording actually took — its
operations, locators, values and checks — plus when it was recorded and which
entry point it started from (`${VAR}` references left unexpanded). It is what
makes browser-free regeneration possible, and it dates the test's origin.

Re-recording replaces the route wholesale, so `ccqa record` writes a
`route-diff.md` beside the spec whenever it replaced an existing recording:
what was added, removed, or changed, grouped by spec step.

```md
## step-02 — Submit the form

- changed: `click text="Submit"` → `click role=button[name="Submit"]`
- added: `assert text_visible "Saved"`
```

### `serialGroups` — specs that must not run at the same time

Raising `--concurrency` runs specs at the same time, which is safe until two
of them write to the same place outside your app: a chat channel, a shared
inbox, a single seeded account. The failure that follows does not look like a
failure — each spec asserts on what it posted and finds the other one's, so
the run goes green or red at random and gets written off as flake.

`serialGroups` is a top-level key in `.ccqa/config.yaml`, sitting alongside
`defaultTarget` and `targets`. The key names the shared thing (a slug: letters,
digits, `.`, `_`, `-`); the list names the specs that write to it:

```yaml
serialGroups:
  notification-channel:
    - notifications/post-message
    - notifications/reply-thread
```

`ccqa run` never runs two members of one group at the same time. Specs
sharing no group still run in parallel, so the cost of protecting a few
specs is not paid by the rest. It applies to every target and both modes,
because the conflict is with the outside world rather than with how the spec
is driven.

Every member is validated against the project's spec inventory: a name that
does not resolve to a real `<feature>/<spec>` is a hard error at run time,
not a silently shrunk group. `ccqa run --dry-run` echoes the groups it read
as `serial: <group-name(s)>` on each affected spec's line, which is how you
confirm a group was read rather than mistyped into silence.

Within one run, `ccqa run` serialises specs sharing a group. Across runs —
with `--only-hub-rerun-needed`, which is where the hub and profile are
resolved — the group is claimed on the hub alongside the specs themselves,
so a second cycle starting while the first is still going leaves those specs
for next time instead of running them into each other. That claim is per
profile, so two profiles reaching the same external service need the
distinction inside the group name (`tenant-a.notification-channel`). See
[ADR-0015](./adr/0015-serial-groups-in-one-place.md).

## `runCommand` — how `ccqa run` executes a target

If a target's config sets `runCommand`, `ccqa run` executes its generated
tests with that command and folds the results into the same report as the
agent-browser specs. Without `runCommand`, the target is generate-only:
`ccqa run` lists its specs as **skipped** instead of silently dropping them.

`runCommand` supports two template variables:

- `{files}` — the spec's generated test files (shell-quoted, cwd-relative).
- `{artifactsDir}` — a per-spec directory
  (`<report-dir>/artifacts/<feature>__<spec>/`) created before the command
  runs. Everything the command leaves there (screenshots, traces, result
  JSON) is recorded as the spec's **artifacts** in the run report, next to
  an always-captured `output.log` of the command's stdout+stderr — so even a
  passed run shows what ran. The directory is also exported to the command
  as `CCQA_ARTIFACTS_DIR`, for tools that can't take it as a flag.

The command also runs with a fresh per-spec `CCQA_RUN_ID` in its
environment — the same contract as the vitest runner, so specs that embed
`${CCQA_RUN_ID}` in created-content names stay collision-free across specs
and runs.

Artifact collection is capped (50 files / 32 MB per spec); anything dropped
is named in a warning, never silently cut. The examples above use
`--output {artifactsDir}` (Playwright: failure traces land in the report)
and `--capture {artifactsDir}` (runn: run captures land in the report).

A failing `runCommand` spec is triaged like any other: with
`ccqa run --on-fail-explain` it gets the same root-cause call and
spec↔code drift audit as an agent-browser spec, built from its generated
test files, the command's output tail, and its `spec.yaml` — see
[Failure triage](./running.md#failure-triage). When the command left a
Playwright `error-context.md` (an accessibility snapshot at the point of
failure) in the artifacts dir, the classifier reads it for extra context.

## Step screenshots for external targets

Playwright specs capture the same per-step **before/after screenshots** an
agent-browser run produces, rendered identically in the hub. You configure
nothing: ccqa's emitter injects `ccqa/step-evidence` calls at each spec-step
boundary of the generated test, and `ccqa run` points the test at the
report's evidence directory through `CCQA_EVIDENCE_DIR`. The calls no-op when
that variable is unset, so running the generated test yourself writes no stray
files.

`ccqa/step-evidence` ships with ccqa — the consumer installs nothing, and ccqa
gains no Playwright dependency (the page is typed structurally). Capture is
best-effort: a failed screenshot is logged and skipped, never a test failure.
After generation, ccqa checks that every step kept its two capture calls and
warns per step if a library-rewrite pass dropped them (the report would
otherwise miss that step's screenshots) — re-run `ccqa generate` if you see
that warning.

This is orthogonal to `--trace`: keep `trace` in your `playwright.config.ts`
(or the `runCommand`, e.g. `--trace retain-on-failure --output {artifactsDir}`)
for the full time-travel trace, which rides along as a run **artifact**. ccqa
handles the step screenshots; Playwright still owns the trace. Targets with no
browser (`runn`) capture no screenshots and say so in the report.

## Per-target guidance prompts

Like `record` and `live`, each LLM-generating target has a hub-stored
guidance pair (`playwright.user` / `playwright.agent`, `runn.user` /
`runn.agent`) injected into its generation prompt. Edit the `.user` file
locally under `.ccqa/prompts/` and upload it with `ccqa hub prompt push
<name>`; see [Hub](./hub.md).
