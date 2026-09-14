# 0033. A recording sits beside the test it compiles into

- Status: accepted
- Date: 2026-09-14

## Context and problem statement

A recording-backed case kept its route at `.ccqa/cases/<id>/ir.json`, a
directory ccqa maintains in parallel to wherever the project's tests actually
live. For a project whose cases are markdown and whose target emits to its own
`testPath`, that directory's only commit-worthy content was the recording, and
reading a test meant holding a mapping to a second tree in your head: this
spec file, that `<id>`, this `ir.json`. Nothing in the recording made the pair
visible from either end.

ADR-0028 had already made "where does this case's test go" answerable from
config alone, by deriving it from a template rather than recording it. That
leaves the recording's home derivable from the same answer.

## Considered options

- **Keep `.ccqa/cases/<id>/ir.json`.** No migration, but the two trees stay,
  and every consumer keeps maintaining the mapping by hand.
- **A config key naming where recordings go.** Answers the complaint, and buys
  a setting nobody has a reason to set differently — plus a second way for two
  projects to spell the same relationship.
- **Derive it from the target's `testPath`.** The recording goes beside the
  test, named by swapping the template's final extension for `.ccqa.ir.json`.

## Decision outcome

Chosen option: "Derive it from the target's `testPath`", because the recording
and the generated test are the two committed halves of one case, and a reader
who opens either should find the other in the same directory.

The name is derived from the target's `testPath` **template**, not from the
path it expands to, because only the template can say which trailing segment
is an extension: in `{case}.spec.ts` the `.ts` is one, and in `e2e/{case}` a
case id of `run.alpha` merely ends in something shaped like one. So the
template's literal tail decides — its final extension is replaced, and a tail
with none gets `.ccqa.ir.json` appended. `specs/{case}.spec.ts` gives
`specs/todo/add.spec.ccqa.ir.json`, `e2e/{case}` gives
`e2e/run.alpha.ccqa.ir.json`, and two cases can never derive one recording.
The `ccqa` token is the tool's namespace: `ir` says what the file is, and
nothing but `ccqa` says whose it is or what wrote it.

The rule is keyed on the target's `testPath` and nothing else, so it is
target-independent — a target that emits `.spec.ts`, `.ts` or `.yaml` gets the
same treatment without knowing this rule exists. A case with no resolvable test
file has nothing to sit beside and keeps its recording in the case's own
directory, as `ir.json`: the spec's own directory for a `spec.yaml` case
(`.ccqa/features/<feature>/test-cases/<spec>/`), and `.ccqa/cases/<id>/` for a
case read from the project's documents.

Every write lands there. A read falls back to the case's own directory so a
project that has not upgraded still works, but nothing writes to that location
again: the first `record`, `generate` or replay repair that saves the recording
moves it and removes the old file.

Deliberately not decided: no config key and no per-target naming hook. This is
the layout, not an option.

### Consequences

- Good: the pair is visible from either file, and a project's recordings are
  reviewed in the same diff as the tests they compile into.
- Good: every other per-case artefact — `runs/`, `evidence/`, `review.json`,
  `route-diff.md` — stays under `.ccqa/cases/<id>/`. Those are regenerable
  output; only the committed half moved.
- Bad / cost: existing consumers see a file rename the first time any command
  writes the recording, in a commit that is otherwise about something else. It
  is one move — a project never holds two files of the same route — and
  `ccqa generate` says where the file went.
- Bad / cost: the location is keyed on the test path a target resolves *now*.
  Changing a target's `testPath` template — or removing it — leaves the
  migrated recordings where the old template put them, and `ccqa perspectives`
  reports such a case as `traced: false`. Recordings are files in git, and a
  `testPath` change is a rename of the tests: rename the recordings in the same
  commit.
- Follow-up: none. A project whose commands only read keeps working on the
  fallback indefinitely.

### Confirmation

Unit tests in `src/store/index.test.ts` pin the derivation, the fallback, the
preference for the sibling when both exist, and the move-and-clean-up that each
of the three writes performs. `src/cli/resolve-case.test.ts` pins that
`--target` redirects the test without moving the recording, and that a spec
whose own target no longer resolves still generates through the override. The
end-to-end `record` scenarios assert the recording lands at the new path for
both an agent-browser spec case and a markdown case emitted through an external
target, and a `generate` scenario runs against a fixture still in the old place
and asserts the file moved.

## More information

- ADR-0028 — a derived test path and a recorded route.
- `getRecordingPath` / `findRecordingPath` in `src/store/index.ts` are the one
  place the rule and its fallback are spelled.
