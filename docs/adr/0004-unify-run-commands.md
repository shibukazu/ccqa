# 0004. Per-spec mode dispatcher: `run` reads `mode:` from spec.yaml, and `record` collapses `trace + generate`

- Status: accepted
- Date: 2026-06-15

## Context and problem statement

The pre-0.8 CLI shipped four execution-flavoured commands (`trace`, `generate`, `run`, and a "non-deterministic" `run-nd`) with overlapping flags (`--drift-report`, `--report-dir`, `--drift-base`, `--session`, `--auto`, `--no-interactive`) whose intent was not obvious from the name. Two separate workflows existed in users' heads — "deterministic" (`trace + generate + run`) and "live" (the `run-nd` flow) — but the commands didn't reflect that grouping. Issue #49 raised that this surface was wide enough to be a friction point on its own, and Issue #47 surfaced that ND-mode failures had no root-cause classification (the existing `analyzeFailure` was tied to the deterministic script + vitest log pair).

## Considered options

- **A. Keep the surface, narrow flag names.** Rename `--drift-report` → `--report`, drop `--session`. Add a separate ND failure analyser. Minimal churn, but two parallel `run` commands remain.
- **B. Single `run` with `--mode=live|deterministic` CLI flag + new `record` for trace+generate.** One execution command, but the user has to remember to pass `--mode` on every invocation and CI configs end up hard-coding the choice per spec — fragile when a project mixes both.
- **C. Single `run` with per-spec mode declared in spec.yaml (no `--mode` CLI flag) + new `record`.** The spec author declares the mode in the spec itself; `run` reads it and dispatches per spec. One run can mix both modes and the HTML report unifies the results.
- **D. Drop the deterministic path entirely; ship live-only.** Smallest surface, but loses the cheap CI-friendly replay that's the whole point of recording.

## Decision outcome

Chosen option: **C**.

A CLI `--mode` flag (option B) forced the choice to live at the invocation site, even though the mode is fundamentally a property of the spec, not the call. Real projects mix both: a stable login flow records once cheaply, while a flaky rich-text editor needs live execution every time. With option C, each spec.yaml declares `mode: deterministic | live` (defaulting to deterministic), `ccqa run <feature>` reads the field per spec and dispatches, and `--report` writes one unified HTML covering both modes in the same page.

Specifically:

- Five commands in lifecycle order: `draft → perspectives → record → run → drift`.
- `run` is a per-spec dispatcher: for each spec it reads `mode:` from `spec.yaml`, then routes deterministic specs through vitest replay and live specs through Claude + agent-browser. No `--mode` CLI flag.
- `record` runs trace then codegen with auto-fix retries; `--skip-trace` / `--skip-codegen` allow either half in isolation. `record` is only meaningful for deterministic specs — live specs need no recorded actions.
- `--report [dir]` is one flag. When set, the HTML report is always written; failure analysis and drift audit run by default. `--no-failure-analysis` opts out of the root-cause classification (and implicitly skips the drift audit, since the audit is rendered as evidence under the classification — without the classification the cost has nowhere to land). `--no-drift-audit` keeps the classification but skips the audit.
  *(Superseded in 1.4–1.6: classification became opt-in via `--failure-analysis [base]` — `--no-failure-analysis` and `--base` are gone — and `--no-drift-audit` was removed; the audit is an input to the classification and always runs with it. See `docs/running.md`.)*
- `--base <ref>` and `--cwd <path>` are shared between `run` and `drift` (and `record` for `--cwd`).
  *(Superseded in 1.4: `run` no longer has `--base` — the baseline is the value of `--failure-analysis [base]` / `--changed [base]`. `drift` keeps `--base`.)*
- `--auto-fix <interactive|auto|skip>` replaces the `--auto` + `--no-interactive` 2-flag matrix on `record`.
- `--changed` on `run` restricts execution to specs whose `relatedPaths` intersect the git diff, scoped to whatever `--base` resolves to.
- `FailureAnalysisPromptInput` is generalised: deterministic runs pass `script` + `failureLog`, live runs pass an `ndTranscriptExcerpt` built from the failing step's log file. `ANALYSIS_PROMPT_VERSION` bumps 3 → 4 so old labels do not get mixed with new ones in accuracy measurements.
- `--session` is removed; every live invocation auto-generates a fresh agent-browser session.

This is a breaking change. No alias period — the user base is small enough that a hard cut is cheaper than a deprecation window.

### Consequences

- Good: the mode is declared once with the spec, so CI configs and shell scripts never need to know it. A project that mixes both modes runs them in one `ccqa run` invocation and gets one report.
- Good: one failure analyser feeds the report regardless of mode; flag names are consistent (`--base`, `--cwd`, `--report`, `--format`) across `run` and `drift`.
- Good: ND failures now get the same root-cause classification deterministic runs already had, so the report's accuracy panel is meaningful in both modes.
- Bad / cost: existing users must rewrite scripts (`ccqa generate X` → `ccqa record X --skip-trace`; `ccqa run --drift-report` → `ccqa run --report`) and add `mode: live` to spec.yaml files that previously relied on the old `run-nd` command.
- Follow-up: doc the migration in the v0.8.0 release notes; consider deeper integration between record's trace and codegen halves in a later issue.

### Confirmation

- `pnpm typecheck` and `pnpm test:unit` pass on the new surface.
- e2e scenarios in `tests/e2e/scenarios/` rewritten to the new flags pass against the mocked Claude + fake-ab harness.
- Manual validation against the playground (a feature containing both `mode: deterministic` and `mode: live` specs) confirmed `ccqa run <feature> --report` runs both, dispatches each spec to the right runner, and produces one unified HTML report with deterministic + live results side by side. A deliberately-broken playground change produces a root-cause classification in the HTML report for failures in both modes.

## More information

- Issue #49 — coordinated CLI redesign request.
- Issue #47 — ND-mode failure classification request.
- `src/cli/run.ts` — per-spec dispatcher.
- `src/cli/spec-mode.ts` — reads `mode:` from spec.yaml.
- `src/cli/record.ts` — combined trace + generate.
- `src/cli/run-live.ts` — live-spec runner (kept as a module; not exported as a CLI command).
- `src/report/prompt.ts` — generalised `FailureAnalysisPromptInput` and prompt version 4.
- `src/report/live-transcript-excerpt.ts` — live-mode transcript summariser.

### Update (v0.9.0)

The original implementation kept the user-facing name `live` (in spec.yaml `mode: live` and in the HTML report's `LIVE` badge) but left the internal `run-nd` / `Nd*` identifiers from the pre-0.8 codebase wherever they sat. v0.9.0 finishes that rename: every internal `RunNd*` / `Nd*` / `nd-*` identifier and file name is now `Live*` / `live-*`, including `src/cli/run-nd.ts` → `src/cli/run-live.ts`, `src/runtime/nd-executor.ts` → `src/runtime/live-executor.ts`, the session-name prefix `ccqa-run-nd-` → `ccqa-live-`, and the report schema field `ndRun` → `liveRun`. Alongside the rename, `.ccqa/prompts/trace.user.md` and `run-nd.user.md` are split into a 4-file bundle — `record.user.md` + `record.agent.md` (for `ccqa record`) and `live.user.md` + `live.agent.md` (for `ccqa run` in live mode) — with a new `--update-agent-prompt` flag on `record` and `run` that asks Claude to rewrite the `*.agent.md` half from the just-completed run's summary. `ccqa init` scaffolds all four files. Spec.yaml `mode:` values are unchanged — the user-facing API stays as is.
