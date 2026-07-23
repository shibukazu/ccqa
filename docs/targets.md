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
| `runn` | spec | No recording step — `ccqa generate` asks Claude to write a [runn](https://github.com/k1LoW/runn) runbook (YAML, validated to parse) directly from the spec and its `relatedPaths` sources | via the target's configured `runCommand` |

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
  <interactive|auto|skip>` (default `interactive`), `--max-retries <n>`
  (default 3), `--force` (overwrite an existing generated test without the
  y/N prompt) — see [Auto-fix](./auto-fix.md) — plus `-m/--model`,
  `--language`, `--cwd`, `--profile`, and the hub connection flags.
- `ccqa record` also accepts `--skip-trace` (reuse the existing `ir.json`),
  `--skip-codegen` (trace only), `--validation-mode <lenient|strict>`, and
  `--update-agent-prompt` (refresh the hub-stored `record.agent` learning
  notes after the trace).

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
    outDir: e2e/specs                # optional — omit to write into the spec's own directory
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
    outDir: runbooks
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

### `outDir` and `generated.json`

By default a generated test lands in the spec's own directory — the same
convention as the agent-browser target, so every spec carries its runnable
test next to its `spec.yaml` (`test.spec.ts` for playwright, `runbook.yaml`
for runn). Configure `outDir` to write into a separate tree instead
(targets then suggest `<outDir>/<feature>/<spec>.spec.ts`; an LLM pass may
relocate within `outDir` to match repo conventions, never outside it).
Each generated spec also gets a `generated.json` manifest in its spec
directory:

```json
{
  "target": "playwright",
  "generatedAt": "...",
  "files": [{ "path": "e2e/specs/tasks/create.spec.ts", "kind": "test", "sha256": "..." }]
}
```

`ccqa run` executes only the `kind: "test"` files; `support` files ride
along with hashes so drift in them is detectable.

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
`ccqa run --failure-analysis [base]` it gets the same root-cause call and
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
