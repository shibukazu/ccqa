# 0002. Never use `agent-browser wait <css-selector>`; poll `get count` instead

- Status: accepted
- Date: 2026-05-24

## Context and problem statement

The single biggest source of "replay-unstable" noise was `agent-browser wait
"<css-selector>"`. It does **not** honour `--timeout`: when the selector never
matches, it blocks the agent-browser daemon for ~150s and then dies with
`Resource temporarily unavailable` (`os error 35`), which cascades into every
following command. Measured directly: `wait "[data-x='NOPE']" --timeout 2000`
took 152212 ms.

This fired constantly because trace-time Claude reads an *accessible name* off
the accessibility-tree snapshot and emits `wait [aria-label='X']`, but the real
DOM frequently derives that name from a `<label>` (no `aria-label` attribute),
so the selector never matches. `wait --text` and `wait --fn` honour the timeout
correctly; `get count "<selector>"` returns in ~180 ms whether the element
exists or not.

## Considered options

- **Keep using `wait <selector>` with a shorter `--timeout`** — doesn't work,
  the flag is ignored for selector waits (it's a `--download` option).
- **Wrap each `wait <selector>` with the process-level hard timeout** — still
  wastes ~35-90s per miss and pollutes the daemon for the next command.
- **Replace selector existence-waits with a `get count` poll** — ccqa controls
  the timeout itself; misses cost ~180 ms, not 150 s.

## Decision outcome

Chosen option: "`get count` poll", everywhere ccqa needs to wait for / assert
an element's presence. `wait <css-selector>` is no longer generated or replayed.
Text/readiness waits keep using the forms that work (`wait --text`, `wait --fn`,
`wait --load`).

### Consequences

- Good: hard-timeout kills and `os error 35` cascades disappeared; replay-unstable
  on the content-management spec dropped from 19 to 1 (the last one is a genuine
  over-assertion that codegen then drops).
- Bad / cost: a few extra `get count` round-trips per wait, each ~180 ms — far
  cheaper than one 150 s wedge.
- Follow-up — a cluster of related fixes fell out of this once the wedge was
  gone, all in the same spirit (don't emit something that can't replay):
  - `wait --load/--fn/--url` are flag-form readiness waits, not selectors —
    validation skips them, codegen skips them (their argument can't round-trip
    through the `AB_ACTION` wire format).
  - over-assertions whose selector `get count` can't find are dropped in codegen.
  - `text_visible` on a value just typed into an input/contenteditable is the
    "input-value trap" (typed text isn't a visible text node) — dropped.
  - contenteditable bodies are entered with `fill`, not the unrecorded
    `keyboard inserttext` (which left the field empty on replay).
  - the post-open settle `sleep` is tracked as a latch so an intervening
    snapshot/comment line can't swallow it.

### Confirmation

`src/runtime/replay-validate.test.ts` and `src/codegen/actions-to-script.test.ts`
cover the `get count` poll path, flag-wait skipping, over-assertion drop, and
the input-value trap. Manually verified `fill` works on `[contenteditable]` via
agent-browser. End-to-end the content-management spec now generates a test that
passes vitest on the first run.

## More information

- `src/runtime/test-helpers.ts` — `abWait` / `abAssertVisible` poll `get count`
- `src/runtime/replay-validate.ts` — `PollCheck`, `runPollCheck`
- `src/runtime/spawn-ab.ts` — `PROCESS_HARD_TIMEOUT_MS` lowered to 35s
- `src/prompts/trace.ts` — forbids `wait <selector>`, steers to `wait --text` / `get count` / `find`
- Relates to [ADR-0001](0001-lenient-post-trace-validation.md)
