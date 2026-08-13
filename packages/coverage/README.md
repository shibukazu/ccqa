# @ccqa/coverage

Instrumentation for the application under test, so `ccqa run --coverage` can
say which of its files each spec actually reached — including the ones a
Temporal activity ran in another process.

The browser half needs nothing installed: `ccqa` reads V8's own counters. This
package is the server half.

## What it does

`ccqa` sets a cookie on the browser at the start of each spec. Every request
that browser makes carries it — and nothing else does, which is what lets an
instrumented server tell one spec's traffic from the rest of a shared
environment's. A load hook rewrites the project's own modules so that entering
one records the file into whichever spec's context the current request belongs
to, and a collector pushes what it has once a second.

While no spec is running, an instrumented call is one global read and one
truthiness test. That is the whole reason this needs no sampling — and the
reason to leave the switch off in production rather than "just leaving it on".

## Install

```sh
pnpm add -D @ccqa/coverage
```

## Turn it on

Three things, and the process is measured:

```sh
CCQA_COVERAGE=1 \
CCQA_COVERAGE_ENDPOINT=http://<host running ccqa run>:4757 \
node --import @ccqa/coverage/register server.js
```

With `CCQA_COVERAGE` unset the register hook is never loaded and the
application pays nothing at all.

| Variable | Meaning |
| --- | --- |
| `CCQA_COVERAGE` | `1` to enable. Any other value is a `<runId>.<specId>` and becomes the ambient spec for a process with no inbound request to read — a worker started per spec. |
| `CCQA_COVERAGE_ENDPOINT` | Where to push. Unset collects in memory and reports nothing. |
| `CCQA_COVERAGE_TOKEN` | Sent as a bearer token, but the current `ccqa` sink does not check it. For a relay in front of it, or a future endpoint that does. |
| `CCQA_COVERAGE_ROOT` | Root that file ids are relative to. Defaults to `process.cwd()`. In a workspace, point it at a directory containing the sibling packages too, and give `ccqa` the same one through `coverage.root`. |
| `CCQA_COVERAGE_INCLUDE` | Comma-separated directories to instrument, relative to the root. Defaults to `src`. |
| `CCQA_COVERAGE_DEBUG` | `1` for diagnostics on stderr. |

### If the server code is bundled

A load hook only ever sees what the runtime loads, so a bundled server is
invisible to it — the bundler already swallowed the sources. Instrument at
build time instead, and keep the register hook: it is what opens the per-request
context the instrumentation records into.

```ts
// next.config.ts
import { withCoverage } from "@ccqa/coverage/next";

export default withCoverage(nextConfig, { root: import.meta.dirname });
```

Only server bundles are touched. The browser is measured through V8's counters
and needs nothing injected.

### If a chat platform drives the flow

A Slack webhook is sent by Slack, not by the browser under test, so none of the
carriers above is present and everything the flow runs would be unattributed.
What the payload does say is which user acted, and recording that is enough for
`ccqa` to work out the rest at its end.

```ts
import { slackActor } from "@ccqa/coverage/slack";

app.use(slackActor());   // after whatever parses the body
```

It takes no arguments on purpose. It does not know which users are being
measured, when a test is running, or what a spec is — the run holds all of
that and nothing is ever sent back here. Which users matter is declared in the
consuming project's `.ccqa/config.yaml`, under `coverage.actors.slack`.

Extraction is a fixed list of the places Slack puts a user id (Events API,
interactivity payloads, slash commands). A shape not on the list records
nothing rather than guessing: a wrong identity is a wrong answer, a missing one
is a counted gap.

### If work continues in Temporal

Three interceptors carry the spec across the three hops. The workflow one lives
at its own specifier because Temporal evaluates it inside a deterministic
sandbox with no Node built-ins. The Temporal SDK is not declared as a
dependency here — these subpaths resolve it from the application's own tree,
and declaring it would put a protobuf runtime in the lockfile of every consumer
that has no Temporal at all.

```ts
import {
  createClientInterceptor,
  createActivityInterceptor,
} from "@ccqa/coverage/temporal";

new Client({ interceptors: { workflow: [createClientInterceptor()] } });

Worker.create({
  interceptors: {
    activity: [() => ({ inbound: createActivityInterceptor() })],
    workflowModules: ["@ccqa/coverage/temporal/workflow"],
  },
});
```

A pre-built workflow bundle takes the same specifier through
`bundleWorkflowCode({ workflowInterceptorModules })`.

The workflow body itself is not measured. It runs in the sandbox, which is one
of the places nothing can reach; the activities it schedules are ordinary Node
and are measured normally.

### If the server is not Node's `http`

`@ccqa/coverage/register` wraps `node:http`, which covers every framework that
receives its requests from it. Anything else — an edge runtime, a fetch-style
handler — opens the context itself:

```ts
import { coverageMiddleware, withCoverage } from "@ccqa/coverage/middleware";
```

## Things that will waste your afternoon

- **A task runner that filters the environment turns this off silently.** If
  the process gets `NODE_OPTIONS` but not `CCQA_COVERAGE` — which is exactly
  what a runner with a declared-variable allowlist does — the preload loads
  and then does nothing. Check that `CCQA_COVERAGE_DEBUG=1` prints `armed in
  pid …` from the process actually serving requests, not just its launcher.
- **Prefer an absolute path in `--import`.** `NODE_OPTIONS` is inherited by
  every child process, and in a monorepo those include packages that cannot
  resolve `@ccqa/coverage` at all. `--import file:///abs/path/to/register.js`
  has no such failure mode.
- **Clear the build cache after adding the plugin.** A bundler that cached its
  modules will not re-run a loader you just added.
- **Never write to stdout from a preload.** It is shared with whatever the host
  process was parsing there. This package writes to stderr only. Most of that
  is behind `CCQA_COVERAGE_DEBUG`, but a handful of warnings that mean nothing
  is being reported at all — no endpoint set, a push failing, the load hooks
  never installing — print regardless, since those are not debugging detail.

## What it cannot see

Declared up front, because a silent gap reads as "never reached" and that is
the answer this exists to produce:

- code that runs outside any request — schedulers, queue consumers, timers
  started before the spec;
- worker threads and other separate isolates, including a Temporal workflow
  body;
- module top level, which runs once and would otherwise belong to whichever
  spec happened to import it first. Recorded separately;
- a process killed outright (`SIGKILL`, an OOM kill) rather than exited — the
  collector flushes on `beforeExit`, which a hard kill never fires.

Executions that run during a spec but outside its context are counted, and
`ccqa` reports the count next to the result.
