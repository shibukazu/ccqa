# 0004. Unify `run` / `run-nd` into a modal `run --mode=live|deterministic` and collapse `trace + generate` into `record`

- Status: accepted
- Date: 2026-06-15

## Context and problem statement

The pre-0.8 CLI shipped four execution-flavoured commands (`trace`, `generate`, `run`, `run-nd`) with overlapping flags (`--drift-report`, `--report-dir`, `--drift-base`, `--session`, `--auto`, `--no-interactive`) whose intent was not obvious from the name. Two separate workflows existed in users' heads — "deterministic" (`trace + generate + run`) and "non-deterministic" (`run-nd`) — but the commands didn't reflect that grouping. Issue #49 raised that this surface was wide enough to be a friction point on its own, and Issue #47 surfaced that ND-mode failures had no root-cause classification (the existing `analyzeFailure` was tied to the deterministic script + vitest log pair).

## Considered options

- **A. Keep the surface, narrow flag names.** Rename `--drift-report` → `--report`, drop `--session`. Add a separate ND failure analyser. Minimal churn, but two parallel `run` commands remain.
- **B. Single `run` with `--mode=live|deterministic` + new `record` for trace+generate.** Two workflows, one execution command, one recording command. One failure analyser shared between modes. Breaking change.
- **C. Drop the deterministic path entirely; ship live-only.** Smallest surface, but loses the cheap CI-friendly replay that's the whole point of recording.

## Decision outcome

Chosen option: **B**, because the user's mental model is two workflows (stability via `draft → record → run --mode=deterministic`, flexibility via `draft → run`), and the surface should match that 1:1 instead of forcing the user to map commands to workflows in their head.

Specifically:

- Five commands in lifecycle order: `draft → perspectives → record → run → drift`.
- `run` is modal: default `--mode=live` (formerly `run-nd`), `--mode=deterministic` (formerly `run`).
- `record` runs trace then codegen with auto-fix retries; `--skip-trace` / `--skip-codegen` allow either half in isolation.
- `--report [dir]` is one flag. When set, the HTML report is always written; failure analysis and drift audit run by default and are opted out with `--no-failure-analysis` / `--no-drift-audit`.
- `--base <ref>` and `--cwd <path>` are shared between `run` and `drift` (and `record` for `--cwd`).
- `--auto-fix <interactive|auto|skip>` replaces the `--auto` + `--no-interactive` 2-flag matrix.
- `FailureAnalysisPromptInput` is generalised: deterministic runs pass `script` + `failureLog`, live runs pass a `ndTranscriptExcerpt` built from the failing step's log file. `ANALYSIS_PROMPT_VERSION` bumps 3 → 4 so old labels do not get mixed with new ones in accuracy measurements.
- `--session` is removed; every live invocation auto-generates a fresh agent-browser session.

This is a breaking change. No alias period — the user base is small enough that a hard cut is cheaper than a deprecation window.

### Consequences

- Good: one execution command matches the two mental workflows; one failure analyser feeds the report regardless of mode; flag names are consistent (`--base`, `--cwd`, `--report`, `--format`) across `run` and `drift`.
- Good: ND failures now get the same root-cause classification deterministic runs already had, so the report's accuracy panel is meaningful in both modes.
- Bad / cost: existing users must rewrite scripts (`ccqa generate X` → `ccqa record X --skip-trace`; `ccqa run --drift-report` → `ccqa run --mode=deterministic --report`).
- Follow-up: doc the migration in the v0.8.0 release notes; consider deeper integration between record's trace and codegen halves in a later issue.

### Confirmation

- `pnpm typecheck` and `pnpm test:unit` pass on the new surface.
- e2e scenarios in `tests/e2e/scenarios/` rewritten to the new flags pass against the mocked Claude + fake-ab harness.
- Manual validation against the playground (`pnpm ccqa record … && pnpm ccqa run --mode=deterministic …` and `pnpm ccqa run …`) confirmed both modes work and a deliberately-broken playground change produces a root-cause classification in the HTML report in both modes.

## More information

- Issue #49 — coordinated CLI redesign request.
- Issue #47 — ND-mode failure classification request.
- `src/cli/run.ts`, `src/cli/record.ts`, `src/cli/run-nd.ts` for the dispatcher / runners.
- `src/report/prompt.ts` for the generalised `FailureAnalysisPromptInput` and prompt version 4.
- `src/report/nd-transcript-excerpt.ts` for the live-mode transcript summariser.
