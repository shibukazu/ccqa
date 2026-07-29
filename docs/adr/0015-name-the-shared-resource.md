# 0015. Specs declare the shared resource they write to, by name

- Status: accepted
- Date: 2026-07-30

## Context and problem statement

`--concurrency` shortens a run by executing specs at the same time. That is
safe until two of them write to the same place outside the application under
test: one chat channel, one shared inbox, one seeded account. Then each spec
asserts on what it produced and finds the other's, and the run goes green or
red by timing.

This failure does not present as a failure. There is no error to read and no
stack to follow — only a spec that passes when run alone and fails in a batch,
which is indistinguishable from flake and gets treated as flake. So the whole
value of raising concurrency is spent re-running a suite nobody trusts.

It is not solved by running everything sequentially either. Live specs are the
slowest thing in a cycle and the reason a cycle exceeds its own polling
interval; serialising them all to protect the few that conflict is what keeps
them out of the loop in the first place (which is where they were).

## Considered options

- **`serial: true` on a spec.** One bit, no vocabulary. But it says a spec
  conflicts with *everything*, so one spec that touches one channel pins the
  whole run to one worker.
- **`conflictsWith: [other-spec, ...]`.** Precise, and quadratic to maintain:
  every new spec touching the same thing edits every existing one, and the list
  goes stale silently when a spec is renamed.
- **Name the resource.** Each spec names what it writes to; two specs naming
  the same thing never overlap.

## Decision outcome

**Name the resource**, as `exclusive:` in spec.yaml — one name or a list:

```yaml
exclusive: notification-channel
```

The declaration stays one line per spec however many specs share the thing,
and it says *why* they conflict, which a list of spec names does not. Specs
with no name in common still run in parallel, so the cost of protecting a few
specs is not paid by the rest.

The names are the project's own — ccqa never interprets them, it only compares
them, case-insensitively. They are validated as slugs so a name cannot be
confused with a spec key (`feature/spec`) once both are lock keys.

### It holds in two places, because there are two ways to overlap

**Within a run**, the worker pool will not start a spec while another holding
one of its names is in flight. It picks the oldest runnable item rather than
the first free one, so a spec waiting on a busy name is not passed over
indefinitely by later ones.

**Across runs**, the name is claimed on the hub alongside the spec keys
themselves (ADR-0014), under the same holder and the same expiry. A resource
another job holds drops every spec needing it from this cycle — running them
anyway is precisely the interference the declaration exists to prevent, and a
dropped spec is picked up by the next cycle.

Resources are claimed before the specs, and only the specs that survive them
are claimed at all: a spec held but not run would read to every other job as
covered when nobody is covering it. For the same reason a hub that cannot
serve the claim fails the run rather than degrading, whenever any selected
spec declares a name — trading a wrong verdict for a completed run is the
wrong way round.

The two denials are not the same fact, so they do not share an exit code. A
denied *spec* means another job is running it: coverage exists, and an emptied
selection exits 0. A denied *resource* means another job is running something
else and these specs go uncovered this cycle, so an emptied selection exits
non-zero, per the rule in ADR-0014 that "nothing to run" reported as a green
run is the outcome the selection path exists to prevent.

The claim rides on `--only-hub-rerun-needed`, which is where the hub and the
profile are both resolved. An explicitly named spec (`ccqa run feature/spec`)
gets the in-run exclusion but no cross-run claim. Two specs conflict because
of what they write, not because of how they were selected, so this is a
limitation of the wiring rather than the model.

Claims are per `(project, profile)`. That is the wrong boundary whenever two
profiles are two *roles* against one deployment — ADR-0013's own reading of a
profile — because both reach the same channel. Naming the tenant inside the
resource (`tenant-a.notification-channel`; the slug charset allows `.`) covers
it today, and moving the claim to project scope later only serialises more, so
deferring is safe.

### It applies to every target and both modes

The conflict is with the outside world, not with how the spec is driven, so
`exclusive:` is not gated on `target:` the way `mode:` and `session:` are.
Every runner that executes specs concurrently reads the same lookup off its
options, next to the `concurrency` it already honours.

## Consequences

Additive on the spec schema: a spec without `exclusive:` behaves exactly as
before, and `--concurrency` keeps its default of 1. `RunnerOptions` gains a
`resources` lookup next to `concurrency` — exclusion is scheduling policy, and
routing it through the options bag keeps the catalog the only place a spec's
names come from, rather than copying the field onto every type that carries a
spec.

Because a claim key is opaque to the hub, the hub cannot tell a resource hold
from any other and so never reports `inProgress` for one: a spec the next run
will refuse still reads `rerunNeeded` in the UI. Closing that means telling
the hub each spec's `exclusive:` names, which is a staleness dependency on
`ccqa perspectives` and not worth it yet.

Nothing detects a *missing* declaration. A spec that writes to a shared thing
without naming it still interferes, exactly as it does today, and the first
symptom is still a flaky-looking failure. A name misspelled on one of two
specs is the same silence, one level up: both halves validate, they claim two
different keys, and nothing collides. `ccqa run` echoes the names it read, and
`--dry-run` echoes them per spec, which is where a typo is visible; a check
that a name is shared by two or more specs would have to come from the spec
inventory and is not built.

## More information

- Field and validation: `src/spec/yaml-schema.ts`
- Within a run: `src/runtime/pool.ts` (`resources`), reached via
  `RunnerOptions.resources` / `src/run/spec-catalog.ts`
- Across runs: `holdSpecs` in `src/run/pipeline.ts`, over the claims of
  ADR-0014 (`src/hub/core/locks.ts`)
- Related: ADR-0014 (claims: lifetime, holder-keyed release, expiry on read)
