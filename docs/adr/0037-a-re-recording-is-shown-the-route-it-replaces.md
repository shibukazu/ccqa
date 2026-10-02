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

The recorder also gets a `replay_step` tool: ccqa runs one step's previous
commands in the trace's own session through the replay validator's action
runner, records those that pass, and stops at the first that fails. The
recorder decides which steps to hand it and finishes a failed one itself, so
a step that still works costs one turn rather than one per command.

Two changes apply to every recording, with or without a map. A
`run_commands` tool runs a batch of commands the recorder wrote, through the
same refusals and the same recording path as its Bash calls, and stops at the
first that fails: exploring a step costs a few turns instead of one per
command. And the recorder is held back once every 30 commands in one step and
asked whether the application matches the step at all; when it does not, it
reports `spec-mismatch` with a rewrite of the step, which the failed
recording carries. Working around a step the application contradicts is what
spent most of the turns measured below, and the recording it produces hides
the mismatch.

### Consequences

- Good: a step whose previous commands still work costs one turn.
- Bad / cost: a previous route that is itself the problem can lead the
  recorder back onto it — `--fresh-ir` is the way out, and the rerecord skill
  says when to use it.
- Bad / cost: steps the previous recording never got right are explored as
  before; the map only helps where it was correct. A step `replay_step`
  completes is not looked at, so a case whose steps are ordered differently
  from the application can be walked past the point a later step needed.

### Confirmation

On the eight-step case above, one trace each, same model and environment:
the default took 787 s, 144 turns and $7.34; `--fresh-ir` took 1700 s, 214
turns and $10.25. The form-filling step fell from 74 commands to 18. That
previous recording was itself broken after the moved step; re-recording again
from the clean recording the default produced took 357 s, 90 turns and $2.54
with commands run one by one, and 210 s, 21 turns and $0.60 with
`replay_step`. On the broken recording `replay_step` took 1608 s: one step it
completed submitted a form the next step needed open, and the recorder spent
72 commands getting back — the same two steps cost `--fresh-ir` 53.

With `run_commands`, the checkpoint and `snapshot -i -c` as the default
snapshot: `--fresh-ir` took 856 s and 89 turns; the clean recording 303 s and
32 turns; the broken recording stopped after 743 s and 83 turns with a
`spec-mismatch` on the step whose order differs from the application, naming
the component that shows the result and suggesting the two steps swap.
