# 0020. Measure what a spec reached, per spec, in a shared environment

- Status: accepted
- Date: 2026-08-13

## Context and problem statement

A suite that is green says nothing about what it never touches. Answering
"which code has no test" needs the reach of each spec — front end and back end
— and the back end is the hard half: a verification environment is shared, so
requests from the specs and requests from everyone else run in the same
processes at the same time. Every coverage tool in every language counts into
one process-global set and resets it globally, which is exactly the shape that
cannot separate concurrent callers. The one public per-trace implementation
(codecov/opentelem-node) held a process-wide lock so only one span could be
measured at a time, and was archived.

## Considered options

- **Time windows.** Run one spec at a time and take the difference of a global
  counter around it. This is what the closest working precedent does, and it
  needs an instance nobody else is using.
- **A forked istanbul, made per-request.** Reuse the standard instrumenter and
  swap its counter object per request.
- **Purpose-built instrumentation keyed on an async context**, with the spec id
  carried from the browser on a cookie.

## Decision outcome

Chosen option: "purpose-built instrumentation keyed on an async context",
because it is the only one that survives other traffic in the same process,
and the environment is shared by assumption rather than by accident.

The spec id travels on a **cookie**, not a header: a header injected into the
browser makes the application's own calls to third-party APIs fail CORS
preflight, and that breakage lands in code the test author does not own. A
cookie is never subject to preflight, rides navigations and service-worker
fetches alike, and is scoped to the origins coverage is configured for.

A forked istanbul was ruled out on a fact, not a preference: its generated
counter function memoises itself on first call, so replacing the counter object
at runtime cannot reach modules that already loaded.

The instrumentation is **file-granular**, and deliberately so. "This file ran"
is what a reader acts on when adding a test, and it removes the entire class of
line- and branch-normalisation errors that mapping V8 ranges back through a
source map otherwise produces.

File granularity is a choice about what to report, not a limit of the
mechanism, and the shape deliberately keeps the finer answer reachable. A
reached id is an opaque string from the point it is produced to the point it is
displayed: the union that merges replicas, the wire, the sink and the report row
all treat it as one. The server-side rewriter already places a probe at every
function body — it passes only the file — so a compound id is a change to two
functions and no formats.

Two things would have to move with it. The browser half resolves V8's ranges to
source *names* and stops there (`src/coverage/frontend/source-map.ts`), so finer output
means real position resolution, and with it the line- and branch-normalisation
errors this decision avoids. And `keepExisting` treats a reported id as a path
to `stat`, which is the one place that assumes the two are the same thing.

A gap counter names something the measurement could not place, and nothing
else. What is dropped on purpose is reported apart from the gaps, and in the
unit the failure actually has — dependency code outnumbers the real gaps by
orders of magnitude, and a process that instrumented nothing is not one missing
file. A number dominated by non-problems, or scaled to understate one, teaches
the reader to skip the section the answer depends on.

### Consequences

- Good: specs stay parallelisable and the environment stays shared. Reach is
  attributed correctly with other traffic running through the same process,
  measured at 120 concurrent uninstrumented requests with zero leakage.
- Good: outside a spec the cost is one global read per module load and one
  truthiness test per call — the reason no sampling is needed. Everyone who
  came before sampled because they instrumented all production traffic.
- Bad / cost: a second artefact to keep in step with the CLI. `ccqa-coverage`
  installs into the application under test and has its own release cadence.
- Bad / cost: three places cannot be attributed at all — code that runs
  outside any request (schedulers, queue consumers), worker threads, and a
  workflow body a deterministic sandbox evaluates. Declared, not hidden.
- Follow-up: only external-target specs are covered. The built-in
  agent-browser paths need the same cookie and a CDP route to V8's counters.

### Confirmation

End-to-end against an application running Next.js and Temporal: a spec recorded
with `ccqa record`, run with `ccqa run --coverage`, produced one file set
spanning the browser, the web server, and a Temporal activity executing in a
**separate process** — all attributed to the same spec. In the same run, 120
concurrent requests without the cookie touched a file that appears in no spec's
set and were counted as unattributed instead.

## More information

- `src/coverage/` — the sink, the merge, and the report row.
- `packages/coverage/` — the instrumentation the application installs.
- Every gap the measurement cannot place is counted and shown next to the
  answer, because an execution that goes missing reads as "never reached",
  which is the answer this whole mechanism exists to produce.
