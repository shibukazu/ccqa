# 0015. Serial groups live in one place: `.ccqa/config.yaml`, not each spec

- Status: accepted
- Date: 2026-07-31

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
  every new spec touching the same thing edits every existing one, and the
  list goes stale silently when a spec is renamed.
- **Name the resource on each spec** (`exclusive: <name>` in spec.yaml). Two
  specs naming the same thing never overlap, and the declaration stays one
  line per spec however many share it. This is where ccqa started, and it has
  its own failure mode — see below.
- **Name the resource once, centrally.** A single list of members per shared
  thing, kept in project config instead of repeated on every spec that writes
  to it.

## Decision outcome

**One list per shared resource, in `.ccqa/config.yaml`, under
`serialGroups`:**

```yaml
serialGroups:
  notification-channel:
    - notifications/post-message
    - notifications/reply-thread
```

The key names the shared thing; the list names the specs that write to it.
`ccqa run` never runs two members of one group at the same time; specs
sharing no group run in parallel.

### Why not per-spec naming

Naming the resource beats listing conflicting spec pairs — one word per group
instead of one edit per pair, and the name says *why* they conflict, which a
list of spec keys does not. But naming it **on each spec** keeps one part of
the pairwise problem: the name itself still has to be spelled the same way in
every spec that shares it, and nothing checks that it was.

No shipped system that uses a free-form resource name for mutual exclusion
validates the string. JUnit 5's `@ResourceLock("key")`, pytest-xdist's
`@pytest.mark.xdist_group`, Bazel's `tags = ["resources:<name>:<n>"]`, and
GitHub Actions' `concurrency.group` are all free-form strings, and none of
them detects a typo. Two tests that should exclude each other, one spelled
`staging-db` and the other `stagng-db`, become two singleton groups that both
run. Silent — the same shape of failure the problem statement opens with, one
level removed: not "no error to read" from a race, but "no error to read"
from a name that quietly failed to unify.

Central membership does not have this failure. A mistyped member is a spec
key, and ccqa checks every member against the project's spec inventory at
parse time — a name that resolves to no spec is a hard error, not a silently
shrunk group. The string-agreement problem disappears because there is only
one string, written once, not restated at every site that needs to agree on
it.

This is **not** the `conflictsWith: [peers]` option rejected above. That
listed every conflicting spec on each spec, so a new spec touching a shared
thing edited every existing one — quadratic. A group is one list per shared
thing: a new spec joins by appending itself to that one list. Linear, and the
list has a single home to read.

JUnit's own mitigations for this same gap point the same way, even though it
keeps the declaration on the test: `Resources.*` constants turn a misspelled
name into a compile error, because it is a symbol and not a restated string,
and `ResourceLocksProvider` computes the key instead of asking every test to
spell it out, so maintaining it is O(1) rather than O(tests). Both are the
same move ccqa makes by centralising: stop asking every declaration site to
independently agree on the same string.

What the central form costs: reading one spec's `spec.yaml` no longer tells
you it is constrained — the constraint lives in config, not on the spec.
`ccqa run --dry-run` echoes `serial: <group-name(s)>` per spec to close that
gap, and a renamed spec now breaks the group's member list loudly (a parse
error) rather than silently dropping out of it.

### Partitioning is the better answer, when the resource can be minted

Playwright's own documented answer to "two tests can't share this" is not to
share it: worker-scoped fixtures keyed on `parallelIndex`, one account minted
per worker instead of one shared and mutually excluded. That is the better
fix whenever the resource can be minted — a database user, a queue.

It does not apply here. A shared chat workspace, a single seeded inbox in a
downstream product, cannot be partitioned the way a throwaway database user
can: there is exactly one of it, and it belongs to whatever application ccqa
is testing, outside ccqa's control to duplicate. Serial groups exist for
precisely the resources partitioning cannot reach — which is why ccqa needs
this mechanism at all, rather than telling every project to mint one account
per worker and be done with it.

### It holds in two places, because there are two ways to overlap

**Within a run**, the worker pool will not start a spec while another holding
one of its groups is in flight. It picks the oldest runnable item rather than
the first free one, so a spec waiting on a busy group is not passed over
indefinitely by later ones.

**Across runs**, the group name is claimed on the hub alongside the spec keys
themselves (ADR-0014), under the same holder and the same expiry. A resource
another job holds drops every spec needing it from this cycle — running them
anyway is precisely the interference the declaration exists to prevent, and a
dropped spec is picked up by the next cycle.

Resources are claimed before the specs, and only the specs that survive them
are claimed at all: a spec held but not run would read to every other job as
covered when nobody is covering it. For the same reason a hub that cannot
serve the claim fails the run rather than degrading, whenever any selected
spec is a member of a group — trading a wrong verdict for a completed run is
the wrong way round.

The two denials are not the same fact, so they do not share an exit code. A
denied *spec* means another job is running it: coverage exists, and an
emptied selection exits 0. A denied *resource* means another job is running
something else and these specs go uncovered this cycle, so an emptied
selection exits non-zero, per the rule in ADR-0014 that "nothing to run"
reported as a green run is the outcome the selection path exists to prevent.

The claim rides on `--only-hub-rerun-needed`, which is where the hub and the
profile are both resolved. An explicitly named spec (`ccqa run feature/spec`)
gets the in-run exclusion but no cross-run claim. Two specs conflict because
of what they write, not because of how they were selected, so this is a
limitation of the wiring rather than the model.

Claims are per `(project, profile)`. That is the wrong boundary whenever two
profiles are two *roles* against one deployment — ADR-0013's own reading of a
profile — because both reach the same channel. Naming the tenant inside the
resource key (`tenant-a.notification-channel` — group names are unrestricted
strings) covers it today, and moving the claim to project scope later only
serialises more, so deferring is safe.

### It applies to every target and both modes

The conflict is with the outside world, not with how the spec is driven, so
group membership is not gated on `target:` the way `mode:` and `session:`
are. Every runner that executes specs concurrently reads the same lookup off
its options, next to the `concurrency` it already honours.

## Consequences

Additive on the spec schema: a spec named in no group behaves exactly as
before, and `--concurrency` keeps its default of 1. `RunnerOptions` keeps its
`resources` lookup next to `concurrency` — exclusion is scheduling policy,
resolved once from `serialGroups` into a per-spec lookup and passed through
the options bag, rather than copied onto every type that carries a spec.

Because a claim key is opaque to the hub, the hub cannot tell a resource hold
from any other and so never reports `inProgress` for one: a spec the next run
will refuse still reads `rerunNeeded` in the UI. Closing that means telling
the hub which groups a spec belongs to, which is a staleness dependency on
`ccqa perspectives` and not worth it yet.

Nothing detects a *missing* declaration. A spec that writes to a shared thing
without being listed in any group still interferes, exactly as it does
today, and the first symptom is still a flaky-looking failure. `ccqa run`
logs the groups it read, and `--dry-run` echoes them per spec, which is where
a spec missing from a group it should be in becomes visible to a human
reviewing the list — nothing checks it automatically, because the missing
case has no string to validate against.

## More information

- Config schema and validation: `src/config/project-config.ts`
  (`SerialGroupsSchema`), inverted into a per-spec lookup and checked against
  the spec inventory by `src/run/serial-groups.ts`
  (`resolveSerialGroups`/`GroupLookup`)
- Within a run: `src/runtime/pool.ts` (`resources`), reached via
  `RunnerOptions.resources`
- Across runs: `holdSpecs` in `src/run/pipeline.ts`, over the claims of
  ADR-0014 (`src/hub/core/locks.ts`)
- Dry-run echo: `src/run/dry-run.ts`
- Related: ADR-0014 (claims: lifetime, holder-keyed release, expiry on read)
