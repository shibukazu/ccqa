# 0032. ccqa runs a generated case only to measure it

- Status: accepted
- Date: 2026-09-11

## Context and problem statement

ADR-0029 gave a project's own markdown test cases a target it defines, and
ADR-0030 taught the audit to read them. The third thing that happens to a test
after it exists is that something decides whether to run it — and for these
cases, ccqa decided not to. `ccqa run` executed a markdown case only when it
said `live`; every other one's test belonged to the project's own runner, and
`ccqa select-specs --format paths` handed that runner the list.

That is still the right split, and it left a hole. Selecting from measured
reach needs a measurement, a measurement is taken while a test executes, and
the only thing that executes these tests is the runner ccqa deliberately does
not drive. So the table stayed empty, every case came back `unknown`, and the
whole point of the selection — running the cases a change could have broken,
and saying so before running them — could not be reached from a standing
start.

Two smaller things blocked the same path. `coverage.projectRoot` refused to
name a directory that does not contain the working directory, which is exactly
where the application is when the tests are their own checkout. And a source
map's relative `sources` were resolved against the working directory, while a
bundler writes them relative to wherever the build ran — so every browser-side
path landed outside the project and the run reported nothing reached, with no
error, because a path above the root is dropped by design.

## Considered options

- **Have `ccqa run` execute every generated case.** Makes the measurement
  possible and takes ownership of running the suite, which is the thing
  ADR-0029 exists not to do: the project has a runner, its CI calls it, and a
  second one racing it is worse than no measurement.
- **Ask the project to instrument its own runner.** Correct in principle and
  unusable in practice: the measurement needs the run ids ccqa issued and the
  turns it opened, which only a ccqa run has.
- **Run a generated case only when something asks for a measurement, or when
  someone named it.**

## Decision outcome

Chosen option: the third, because it keeps the default — your suite is yours —
while making the one thing that cannot be done any other way possible.

`ccqa run` executes an external target's generated cases through that target's
own `runCommand` when either is true:

- `--coverage` is on, because observing the test execute is what a measurement
  is, and there is no other moment to take it;
- cases were named on the command line, because that is someone asking for
  these ones.

A plain `ccqa run` still reports what it always did: these cases are the
project's runner's, and `select-specs --format paths` is how it gets them. The
row is the case, the report and the hub push address it by its own id, and
`--report-junit` carries it like any other.

Alongside it, two rules about where things are:

- **`coverage.projectRoot` may name a directory outside the working
  directory**, absolute or relative, resolved through symlinks before it is
  compared with anything. It is a config error when it is not there.
- **`coverage.sourceBase` names where the build ran**, for resolving a source
  map's relative `sources`. It defaults to the working directory, need not sit
  inside `projectRoot`, and `include` stays relative to `projectRoot`.

### Consequences

- Good: measured reach exists for a project whose cases are its own documents,
  which is what `select-specs` needed to answer anything at all.
- Good: nothing about an ordinary `ccqa run` changes, so a project that never
  measures never notices.
- Bad / cost: under `--coverage` the suite runs twice in a pipeline that also
  runs it itself. That is the price of the measurement and it is paid on
  purpose; a project that minds runs the measuring job on its own schedule.
- Bad / cost: two conditions rather than a flag of its own. A flag would be
  one more thing to know, and both conditions already mean "run this now".
- Follow-up: `--only-*` selection filters narrowed one list while the phases
  rebuilt from another, so a markdown project ran everything it had just
  filtered out. Every phase now derives from the filtered list — which is the
  normalized case list ADR-0029's PR deliberately left, arrived at from the
  other side.

### Confirmation

`tests/e2e/scenarios/select-and-junit.test.ts` selects a markdown case from a
change made in a separate application checkout, with `coverage.projectRoot`
pointing outside the working directory and `--repo` naming the application's
repository, and asserts the path handed back is the one the project's runner
takes. Unit tests cover the root resolution (outside cwd, through a symlink,
missing, empty) and the dispatch of generated cases to the target's runner.

## More information

- [ADR-0029](./0029-ccqa-ships-mechanism-the-project-supplies-the-facts.md) —
  why the project's runner owns the suite.
- [ADR-0024](./0024-selection-from-measured-reach.md) — what the
  measurement is for.
- `src/run/pipeline.ts`, `src/run/target-dispatch.ts`, `src/coverage/session.ts`.
