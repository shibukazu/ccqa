# 0001. Post-trace validation defaults to lenient (warn, don't drop)

- Status: accepted
- Date: 2026-05-24

## Context and problem statement

After a trace, ccqa replays the recorded `actions.json` once against a fresh
agent-browser session to catch actions that won't reproduce. Originally a failed
replay **dropped** the action from `actions.json`, so it never reached the
generated test. In practice this deleted whole spec steps: trace-time Claude has
snapshots, adaptive waits, and retries, but the headless linear replay does not,
so it fails on actions that are actually fine in a real run. A real spec
lost its "verify created content" and "delete" steps entirely while the trace
itself reported all steps passing.

The replay is *also* redundant with `ccqa generate`'s auto-fix loop, which runs
the generated test under vitest and diagnoses failures. Two independent
robustness checks fighting each other shouldn't silently delete the user's
spec coverage.

## Considered options

- **Keep strict drop** — simplest, but keeps deleting load-bearing steps.
- **Lenient default: tag failures, keep them** — replay failures become
  warnings carried into the generated test; the auto-fix loop / human decides.
- **Remove post-validation entirely** — rely only on the auto-fix loop.

## Decision outcome

Chosen option: "lenient default", because it preserves every recorded step
while still surfacing replay risk, and leaves the runtime verdict to the
auto-fix loop (which has more signal than a blind replay). Strict mode stays
available via `--validation-mode strict` for callers who want the old behaviour.

### Consequences

- Good: spec steps can no longer silently vanish; failures show up as
  `// [warn] replay-unstable: <reason>` comments in the generated test, which
  also give the auto-fix `diagnose` step a strong hint (observed it move a
  SELECTOR_DRIFT confidence from 0.30 → 0.55).
- Bad / cost: the generated test may include actions that fail at runtime; the
  auto-fix loop or a human must resolve them. We mitigate this in codegen by
  dropping a few classes of provably-unreplayable assertions (see ADR-0002 and
  the over-assertion / input-value-trap handling in `actions-to-script.ts`).
- Follow-up: the `replayUnstable` / `replayReason` fields must survive the LLM
  cleanup pass — `cli/generate.ts:mergeFromOriginal` restores them, since the
  cleanup prompt doesn't echo them.

### Confirmation

Unit tests in `src/runtime/replay-validate.test.ts` cover lenient vs strict and
the rescue pass. End-to-end: re-tracing the content-management spec stopped
losing steps; the generated test exercised create → verify → delete → confirm
absence and passed under `ccqa generate` and a fresh `ccqa run`.

## More information

- `src/runtime/replay-validate.ts` — `ValidationMode`, `validateActions`, `rescueLostSteps`
- `src/codegen/actions-to-script.ts` — emits the `replay-unstable` breadcrumb
- Relates to [ADR-0002](0002-avoid-agent-browser-wait-selector.md)
