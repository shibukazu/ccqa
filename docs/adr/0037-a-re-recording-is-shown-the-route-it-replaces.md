# 0037. A re-recording is shown the route it replaces

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

`ccqa record` traced every case from nothing. A re-recording is usually one
moved screen in a route that otherwise still works, yet the recorder
rediscovered every step by snapshot — including form steps with custom
controls, where most of its turns went. An auto-fix job re-recording an
eight-step case after one navigation moved spent 25 to 60 minutes and 200 to
350 turns per attempt, and often failed in a step that had not changed.

The recording being replaced already holds what each step did, tagged by step.

## Considered options

- **Replay the old route and trace only the steps that fail.** Deterministic
  where it holds. Rejected: a replay that passes proves the old actions still
  run, not that they do what the step says now — an edited `expected` would be
  silently skipped — and splicing traced and replayed segments into one
  browser session adds an orchestrator, several model sessions and a stitching
  format to maintain.
- **Show the old route to the recorder as a map.** One model session, as
  today. The recorder runs a step's previous commands first and falls back to
  exploring only where they fail; the spec stays the contract, so assertions
  follow the current `expected`.

## Decision outcome

Chosen option: "show the old route as a map", because it removes the
rediscovery without a second recording mechanism or a new way for a stale
recording to pass.

The trace prompt gets a "Previous recording" section: each step's actions as
the commands that perform them, assertions as their marked probes. Actions in
the first step the previous validation found broken are marked; failures in
later steps are not, since the validator replays them on whatever page the
broken step left. On by default whenever a recording exists; `--fresh-ir`
records from nothing.

### Consequences

- Good: a step whose previous commands still work costs about one turn per
  action.
- Bad / cost: a previous route that is itself the problem can lead the
  recorder back onto it — `--fresh-ir` is the way out, and the rerecord skill
  says when to use it.
- Bad / cost: steps the previous recording never got right are explored as
  before; the map only helps where it was correct.

### Confirmation

On the eight-step case above, one trace each, same model and environment:
the default took 787 s, 144 turns and $7.34; `--fresh-ir` took 1700 s, 214
turns and $10.25. The form-filling step fell from 74 commands to 18. That
previous recording was itself broken after the moved step; re-recording again
from the clean recording the default produced took 357 s, 90 turns and $2.54.
