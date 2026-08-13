# Coverage: what a spec actually reached

A green suite says nothing about the code it never touches. `ccqa run
--coverage` measures which files each spec really executed — in the browser
and in the server — and records the set on the spec's row, so "nothing covers
this" becomes a question with an answer.

It is a measurement, not an estimate. The browser side reads V8's own counters;
the server side is instrumented per request. Both sides carry the same spec id,
so their results are one set.

## What you need

**The browser side works on its own.** Regenerate the spec (`ccqa record` or
`ccqa generate`) so the emitted test carries the coverage calls, and add a
`coverage:` block:

```yaml
# .ccqa/config.yaml
coverage:
  origins:
    - https://app.example.test   # or ${APP_BASE_URL}
  sink: http://127.0.0.1:4757    # optional; this is the default
```

`sink` is the address **the run itself binds** for its duration — not the hub.
The hub stores results and never executes; working out which spec a push
belongs to needs the ids this run issued and the turns it opened, and only the
run has those. `ccqa serve` is not involved.

`origins` has no default on purpose. It lists where the spec cookie may go, and
a spec routinely visits origins that are not the application — an identity
provider, a payment page. Guessing would hand a test marker to a third party.

**In a workspace, widen the root.** Reported paths are relative to the project
root, and anything resolving above it is dropped rather than guessed at — so a
sibling package the application imports runs, and is reported by nobody. Point
`root` at a directory that contains both:

```yaml
coverage:
  root: ../..                    # relative to the project root
```

The application's own `CCQA_COVERAGE_ROOT` has to name the same directory. Root
the two halves differently and one file arrives under two names.

A package is imported through its build output, so that is what the bundler
names. Where the output has a map beside it naming a single source — what an
unbundled compile produces — the source is reported instead; a bundle's map
cannot say which of its inputs the file is, so those stay as they are.

**The server side needs the application instrumented** with
[`ccqa-coverage`](../packages/coverage/README.md) and pointed at the sink
through `CCQA_COVERAGE_ENDPOINT`. Without it the run still reports the browser
half.

The default binds loopback, which fits an application on the same machine and
nothing else. Measuring a deployed one means two more things being true:

- **The address is one the application can reach.** It has to be routable from
  wherever the application runs, on a port its outbound rules allow — commonly
  only the ones it already needs, so an arbitrary port is a poor assumption.
- **It is not one anybody else can.** The sink authenticates nothing. Its gate
  is the set of spec ids the run issued, which stops a stale or invented id
  from landing in a report, but it is not a reason to expose the port.

A sink the application cannot reach shows up as `droppedPushes` climbing with
no server files at all.

Then:

```sh
ccqa run --coverage
```

## Flows a webhook drives

A spec that drives the application through a chat platform reaches it by a
route the cookie cannot follow: the browser only ever talked to the platform,
and what arrives is a webhook the platform sent. Everything such a flow runs
would be unattributed.

What the webhook does carry is **who** acted. Declare which specs act as which
identity, and one spec at a time is given that identity's turn:

```yaml
coverage:
  actors:
    slack:                          # the preset's tag prefix
      ${TEST_USER_ID}: [chat/create-item, chat/resolve-item]
```

The application adds one line, after whatever parses the body:

```ts
import { slackActor } from "ccqa-coverage/slack";
app.use(slackActor());
```

Three properties are worth knowing, because everything else follows from them:

- **Nothing is sent to the application.** It records who acted and when, and
  never learns which identities are measured or whether a spec is running. All
  of that is decided by the run, so there is no table to distribute, go stale,
  or leak one project's identities into another's logs. `slackActor()` takes no
  arguments for that reason.
- **Specs sharing an identity take turns**, with a few seconds of quiet between
  them. Both sides stamp times with their own clock, and a gap is what makes an
  event near a boundary unambiguous without either having to trust the other.
  This happens only under `--coverage`.
- **Work is attributed to when it was asked for**, not when it ran. A queued job
  picked up minutes later still carries the instant of the request that caused
  it, so a slow tail lands in the turn that started it.

Only `--coverage` reads any of this. Declaring an identity whose variable is
unset, two entries resolving to the same identity, or a spec that does not
exist all stop the run rather than measure under a guess.

Events from identities the project never declared — other people on a shared
environment — are counted and their identity dropped on arrival. Events from a
declared identity outside its turn are a warning: something other than the run
drove it, and what it reached is missing from a row that otherwise looks whole.

## Reading the result

Each spec row carries the file set and, above it, everything the measurement
could not place. Two of those are words rather than numbers, because "that half
never answered" and "that half reached nothing" are otherwise the same zero:

- **no instrumented server process reported** — the application is not running
  with `ccqa-coverage`, or cannot reach the sink.
- **the browser produced no result** — the generated test is missing its
  coverage hooks (regenerate the spec), or the row is a live spec, which drives
  its own browser and is measured on the server side only.
- **browser collection stopped early** — the driver refused a read mid-spec,
  so everything after that point went unseen.

One more is said only at the end of the run, because it is a fact about the
run rather than about a row: **instrumented processes reported but no spec was
attributed to them**. An application reports its boot set whether or not a spec
cookie ever arrives, so without this the rows all say the server reached
nothing and every counter agrees. It means the cookie is not getting through —
`coverage.origins` is missing an origin the spec's requests go to, or a server
that is not `node:http`-based never installed the middleware.

| Counter | What it means |
| --- | --- |
| `unattributed` | Server executions during this spec that ran outside its context. Work started before the spec (a scheduler, a queue consumer) lands here, and so does other traffic on a shared environment. |
| `unmappedScripts` | Browser scripts that ran but had no usable source map — usually the framework's own chunks. |
| `unmappedRanges` | Executed code that mapped to no original source. |
| `outsideProject` | Browser sources that resolved to a path the project does not contain. Dropped from the set rather than reported as project code nobody tests. |
| `unresolvedSources` | Browser sources whose name could not be turned into a project path at all. In a workspace this is where a sibling package lands when the root is too narrow. |
| `uninstrumentedFiles` | Server files the instrumentation could not rewrite. They can never report reach, so they would otherwise look untested. |
| `uninstrumentedProcesses` | Server processes that instrumented **nothing at all** — every file they ran is missing, not just some. Load hooks need node 22.15+ (23.5+ on 23.x); code a bundler already swallowed needs the build plugin instead. |
| `droppedPushes` | Reports the application could not deliver while this run was measuring. What a process had already dropped before the run started is not counted against it. |
| `unmappedActorEvents` | Events from identities this project does not declare — other traffic on a shared environment. The identity is dropped on arrival, so only the count remains. |
| `outsideWindowEvents` | Events from a **declared** identity that arrived outside its turn. Something other than the run drove it. |

They sit next to the answer rather than in a log, because a missing
execution reads exactly like "never reached", and telling the two apart is
the point.

`excludedDependencies` sits apart from them. Dependency code is dropped on
purpose — nobody writes a test because a library file went unreached — and it
outnumbers the real gaps by orders of magnitude, so counted alongside them it
would bury them.

## What it cannot see

- Code outside any request: schedulers, queue consumers, timers that were
  already running.
- Worker threads and other isolates — including a Temporal workflow body. The
  activities such a workflow schedules **are** measured, in whatever process
  runs them.
- Module top level. It runs once, so the first spec to import a module would
  otherwise own it and a spec's result would depend on execution order. Kept in
  a separate set.
- The browser half of a live spec. Live specs drive agent-browser, which runs
  no generated test and so carries none of the hooks; their server half is
  measured normally. A target whose generated tests lack the hooks says it was
  not measured rather than reporting an empty result.
- Work that lands more than ten seconds after a spec's test process exits. The
  run waits for the application to stop reporting, but not indefinitely.
