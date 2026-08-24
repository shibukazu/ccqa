# Coverage: what a spec actually reached

A green suite says nothing about the code it never touches. `ccqa run
--coverage` measures which files each spec really executed — in the browser
and in the server — and records the set on the spec's row, so "nothing covers
this" becomes a question with an answer.

It is a measurement, not an estimate. The browser side reads V8's own counters;
the server side is instrumented per request. Both sides carry the same spec id,
so their results are one set.

## What you need

**The browser side works on its own.** Nothing is emitted into the generated
tests and nothing has to be regenerated: under `--coverage` the run attaches
to the browser the target drives (over the Chrome DevTools Protocol), plants
the spec cookie, and reads V8's counters from outside. Every browser-driving
target is measured the same way — how the run reaches each target's browser
is the target's own declaration (`browserCoverage`), and it is the only
per-target piece. This half needs Node 22+ for the run itself (the CDP
transport); on an older Node the attach fails and the row says so, rather
than reporting an empty file set.

Add a `coverage:` block:

```yaml
# .ccqa/config.yaml
coverage:
  instrumentedOrigins:
    - https://app.example.test   # or ${APP_BASE_URL}
  sink: http://127.0.0.1:4757    # optional; this is the default
```

`sink` is the address **the run itself binds** for its duration. That is the
default shape — application and run meeting on one machine — and one of two.
Where they cannot share a machine, the hub can host the meeting point
instead: see "A deployed application: the hub inbox" below.

`instrumentedOrigins` is where the spec cookie is allowed to go, and has no
default on purpose. A spec routinely visits origins that are not the
application — an identity provider, a payment page — so guessing wide hands
a test marker to a third party, and guessing narrow loses that origin's
reach entirely.

The name is the rule for adding one: an origin whose server runs the
instrumentation below. With nothing instrumented yet, list the application's
own — the cookie is inert until something reads it, and the server half then
starts reporting the moment you install `ccqa-tools`.

**In a workspace, widen what counts as the project.** Reported paths are
relative to it, and anything resolving above it is dropped rather than
guessed at — so a sibling package the application imports runs, and is
reported by nobody. Point `projectRoot` at a directory that contains both:

```yaml
coverage:
  projectRoot: ../..             # relative to the directory holding .ccqa/
```

The application's own `CCQA_COVERAGE_ROOT` has to name the same directory. Root
the two halves differently and one file arrives under two names.

A package is imported through its build output, so that is what the bundler
names. Where the output has a map beside it naming a single source — what an
unbundled compile produces — the source is reported instead; a bundle's map
cannot say which of its inputs the file is, so those stay as they are.

**Name the denominator to see what was _not_ reached.** `include` lists the
source directories the measurement could have reached, relative to
`projectRoot` — the same directories the application's
`CCQA_COVERAGE_INCLUDE` names:

```yaml
coverage:
  include:
    - src
    - packages
```

The run enumerates them when the measurement starts, from the same checkout
it measures, and ships the list inside the report — there is no separate
sync channel to drift out of step. A hub receiving such a report draws the
full file tree on its Coverage page, unreached files called out. Without
`include` the hub shows reached files only and calls nothing uncovered.

Vendored and generated directories (`node_modules`, `dist`, `build`, `out`,
`coverage`, dot-directories) are skipped. An `include` that matches nothing,
or more than 20,000 files, drops the whole list with a warning rather than
shipping a denominator that would misreport "uncovered".

**The server side needs the application instrumented** with
[`ccqa-tools`](../packages/tools/README.md) and pointed at the sink
through `CCQA_COVERAGE_ENDPOINT`. Without it the run still reports the browser
half. The variable defaults to `http://127.0.0.1:4757` — the sink's own
default bind — so an application on the same machine needs no endpoint
configuration; only a deployed one sets it. If a gateway in front of the
endpoint gates on a header, set `CCQA_COVERAGE_HEADER` to a single
`name:value` pair and the collector sends it with every push.

The default binds loopback, which fits an application on the same machine and
nothing else. A sink the application cannot reach shows up as `droppedPushes`
climbing with no server files at all.

Then:

```sh
ccqa run --coverage
```

## A deployed application: the hub inbox

A deployed application and the machine running `ccqa run` usually cannot meet
on a loopback port: the runner may be ephemeral, its address different every
run, its network closed to inbound traffic. `--coverage-inbox hub` moves the
meeting point to the hub (ADR-0022):

```sh
ccqa run --coverage --coverage-inbox hub
```

Coverage becomes an append-only event stream the hub stores. The application
pushes to a **stable** URL — the same body it always pushed, so a collector
already deployed keeps working:

```sh
CCQA_COVERAGE_ENDPOINT=https://hub.example.test/api/v1/coverage/events?project=my-app
CCQA_COVERAGE_TOKEN=<append-only token>       # CCQA_HUB_COVERAGE_TOKEN on the hub
CCQA_COVERAGE_HEADER=name:value               # only if a gateway gates on one
```

The token is deliberately not the hub's bearer token: it can append coverage
events and nothing else, so the credential sitting in an application's
environment can at worst inject fake measurements — it reads nothing and
cannot forge the run's own markers. The run, for its part, binds no sink and
writes no coverage into the report: it appends its own facts — spec and
window markers, the browser half, the enumerated universe — to the same
stream, and the hub's Coverage page resolves the stream on read. In this mode
the stream is the record; an interrupted run has already delivered everything
it measured.

Pair it with `--report-to-hub` if the Coverage page's cases should link to
their run pages: the link needs a run record to point at. Without one the
links are simply absent — the measurement itself is unaffected.

Local runs need none of this: the default (`--coverage-inbox local`) is the
loopback sink above, no hub involved, and the report rows carry the results
as they always did.

### Reading a streamed measurement back

Because the rows carry no coverage in this mode, an empty measurement is easy
to miss: the run passes, the stream accepts every event, and only days later
does selection degrade to `unknown`. Two read-outs close that gap:

- At the end of a streamed run, `ccqa run` asks the hub to resolve the run's
  slice of the stream and prints the answer: how many specs measured files,
  which measured none, and the stream's health counters (application pushes
  during the run, attributed specs, out-of-window events).
- `ccqa hub coverage` prints the same resolve on demand — per-spec measured
  file counts (`--files` lists the files, `--json` the raw answer) and the
  health counters, for the most recent measured run or `--run-id <id>`. This
  is the read-out measured spec selection consumes, so when a spec's verdict
  is `unknown`, this command shows whether the measurement was empty and why.

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
import { slackActor } from "ccqa-tools/coverage/slack";
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
  with `ccqa-tools`, or cannot reach the sink.
- **the browser produced no result** — the run could not attach to the
  target's browser (the row's `coverageUnavailable` says why), or the target
  declared no browser to measure.
- **browser collection stopped early** — the browser went away mid-spec, so
  everything after that point went unseen.

One more is said only at the end of the run, because it is a fact about the
run rather than about a row: **instrumented processes reported but no spec was
attributed to them**. An application reports its boot set whether or not a spec
cookie ever arrives, so without this the rows all say the server reached
nothing and every counter agrees. It means the cookie is not getting through —
`coverage.instrumentedOrigins` is missing an origin the spec's requests go to,
or a server that is not `node:http`-based never installed the middleware.

| Counter | What it means |
| --- | --- |
| `unattributed` | Server executions during this spec that ran outside its context. Work started before the spec (a scheduler, a queue consumer) lands here, and so does other traffic on a shared environment. |
| `unmappedScripts` | Browser scripts that ran but had no usable source map — usually the framework's own chunks. A count in the hundreds, with `features` almost empty, means the deployment does not serve its maps at all; see "When the build does not serve its source maps" below. |
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
purpose — nobody writes a test because a library file went unreached — and
it outnumbers the real gaps by orders of magnitude, so counted alongside
them it would bury them.

### When the build does not serve its source maps

Deleting `.map` before publishing the assets is a normal choice — a map carries
the original source. It also leaves the browser half unable to name a single
file: every script counts under `unmappedScripts`, the row reports server files
only, and `ccqa select-specs` then answers `notNeeded` for a spec whose subject
is a screen.

Push the maps to the hub at deploy time instead, and the run reads them from
there (ADR-0025):

```sh
ccqa hub sourcemap push .next/static --sha "$DEPLOYED_SHA" --asset-prefix _next/static
```

Run it **before** the step that deletes the maps, in the job that built them.
Only the fields coverage reads are sent — the original source each map carries
is dropped rather than uploaded, so the hub holds file names and offsets, not
source.

Two things have to line up for the read side to find them:

- The `--sha` must be the commit the deploy is recorded under (`ccqa hub deploy
  record`). The run asks for the commit the deploy log says is live.
- `--asset-prefix` plus the file's path under the directory must equal what the
  browser requests, minus the origin. Assets served from a different host than
  the application need that host in `coverage.assetOrigins`; the spec cookie is
  never attached there, which is why it is a separate list from
  `instrumentedOrigins`.

`ccqa hub sourcemap ls --sha <sha>` shows what a push landed.

## What it cannot see

- Code outside any request: schedulers, queue consumers, timers that were
  already running.
- Worker threads and other isolates — including a Temporal workflow body. The
  activities such a workflow schedules **are** measured, in whatever process
  runs them.
- Module top level. It runs once, so the first spec to import a module would
  otherwise own it and a spec's result would depend on execution order. Kept in
  a separate set.
- The tail of what a page ran right before an external test process closed it.
  The engine drains counters on a short interval; what executed inside the
  final one is gone with the page. Live specs have no such tail — their
  browser outlives the spec, and the engine takes its final read first.
- Work that lands more than ten seconds after a spec's test process exits. The
  run waits for the application to stop reporting, but not indefinitely.
