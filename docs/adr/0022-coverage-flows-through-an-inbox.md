# 0022. Coverage flows through an inbox; interpretation is one resolver

- Status: accepted
- Date: 2026-08-17

## Context and problem statement

The coverage sink (ADR-0021) is one object doing two jobs: a **transport
endpoint** — an HTTP server the instrumented application pushes to — and an
**interpreter** — the gate on issued spec ids, the actor-window join on a
single clock, the loss counters. Fusing them binds the transport to the run's
host, and that binding fails exactly where coverage matters most: a deployed
application measured from a CI runner. The application's push target is a
static environment variable, but the runner is ephemeral — a different address
every run, in a network segment that (rightly) accepts no inbound traffic.
There is no rendezvous point, so the server half of coverage silently measures
nothing in CI.

Meanwhile the hub is deliberately a storage plane that computes nothing
(ADR-0004, ADR-0017). Whatever shape the answer takes has to say precisely
what, if anything, that principle concedes.

## Considered options

- **Open a network path to the runner.** Security-group holes or peering into
  the runner's network, plus some stable address (load balancer, fixed nodes)
  in front of ephemeral runners.
- **Interpret at ingest.** The application pushes to the hub and the hub
  materializes per-spec results as events arrive; the derived state becomes
  the record.
- **An inbox the parties meet at**: coverage becomes an append-only event
  stream; the hub can host the inbox; interpretation stays a pure function,
  resolved on read — by the hub's API or by the CLI.

## Decision outcome

Chosen option: "an inbox the parties meet at", because it is the only shape
that reaches a deployed application without opening a network boundary,
while keeping interpretation a single reproducible function.

**Coverage is an append-only event stream.** Producers are the instrumented
application (server-half reach, actor events) *and the run itself* (browser
coverage as CDP takes resolve, the enumerated universe, actor-window
open/close markers, spec lifecycle markers). Consumers interpret; the stream
itself is facts only.

**The inbox is one interface with two implementations.** `--coverage-inbox`
selects per execution:

- `local` (default): the run binds a loopback inbox for its own duration —
  today's sink transport, unchanged, no hub involved. The run's resolver
  interprets at spec close and the results land where they always did.
- `hub`: nobody binds anything on the runner. Application and run both append
  to the hub's durable inbox over HTTPS; the hub stamps arrival order, stores,
  serves reads, and expires — storage-plane work, no interpretation. The run
  writes **no coverage into report.json and no local coverage artifacts**;
  the event stream is the record. Streaming as events are produced also means
  an interrupted run has already delivered everything it measured.

The destination is a flag, not project config, because it names an execution
fact, not a project fact: the same project legitimately runs `local` on a
laptop and `hub` in CI, and a config key would be wrong in one of the two.
The application only ever knows `CCQA_COVERAGE_ENDPOINT`; whether that URL is
a run-local inbox or the hub's is invisible to it. The two sides must agree
per environment; a mismatch is caught by the existing "no instrumented server
process reported" health warning, not by silence.

**Interpretation is one shared resolver, resolved on read.** The gate on
issued ids, the actor-window join, and the loss accounting are a pure
function over the ordered stream. That function ships once and runs in two
hosts: the CLI (for `local` mode) and the hub's API (for `hub` mode), which
resolves when asked and serves the result. The UI is a renderer over that
API — colouring, not logic — and any other consumer (test-impact selection,
tooling) gets the same resolved answer from the same endpoint instead of
re-deriving it. Two implementations of the join would drift the way any
duplicated definition drifts; one module consumed by both hosts is a hard
requirement, not a preference. The run's markers carry everything
interpretation needs — which ids this run issued, whose turn a window was —
so a stream plus nothing else is resolvable; several runs interleaving in
one project's stream stay separable because each run's markers bound its
own view of it.

This amends the no-compute rule in a bounded way: the hub gains
deterministic **read-time** computation — a pure function over stored facts,
no model calls, no mutation of the record. What is stored stays facts only;
a resolved answer may be cached keyed by stream position, but the cache is
never the record. Interpreting at ingest was rejected precisely because it
crosses the line this stops at: derived state becoming the stored truth.

The single clock ADR-0021 requires survives the move: in `hub` mode the
hub's arrival stamps order both the application's events and the run's
window markers, so the join still reads one clock — it is the sink's receive
clock relocated, not replaced.

**The inbox takes its own credential.** The hub bearer token authorizes
everything, including reading stored secrets; it must never sit in an
application's runtime environment. The hub inbox instead accepts a dedicated
append-only token (`CCQA_COVERAGE_TOKEN` — the collector already sends it),
valid for appending coverage events and nothing else. Leaking it from a
compromised application yields the ability to inject fake measurements —
detectable pollution, not a secrets breach — and it rotates independently of
the CI credential.

One thing changes hands with the move: actor events carry the identity tags
the application observed, and today those exist only in the run's memory —
undeclared ones are dropped on arrival. In `hub` mode they land in storage.
The inbox therefore stores event payloads encrypted at rest, exactly as the
hub already stores its other secrets, and expires them with the retention
bound; resolved output keeps only the declared display keys, as it does
today.

### Consequences

- Good: a deployed application reaches the inbox over plain HTTPS egress; no
  security-group changes, no stable-address machinery in front of runners.
- Good: interruption resilience — events are durable the moment they are
  appended, where today a dying run loses its unsealed coverage.
- Good: the coverage page reads the resolved answer from the API instead of
  probing recent run reports, removing that scan — and the same endpoint
  serves every other consumer.
- Bad / cost: in `hub` mode the server-half answer lives only in the hub;
  report.json is no longer a complete coverage record there. Consumers that
  want reach edges (test-impact selection) read the hub — which they already
  do for the ledger.
- Bad / cost: the wire grows an inbox API and the report loses fields in one
  mode; hub and clients move together (ADR-0018 discipline applies).
- Follow-up: define retention and size limits for the inbox; define how the
  resolver reports a stream that is still growing (a page rendering mid-run
  shows an honest "as of", as the coverage page already does).
- Follow-up: default the collector's push target to the loopback inbox, so a
  local stack needs no endpoint configuration at all; only a deployed
  environment writes one — once. The endpoint stays a per-environment
  constant and deliberately never rides the cookie: the cookie is an inert
  marker, and a value an outsider can set must never become an instruction
  the application executes (a URL to POST to is exactly that).

### Confirmation

A deployed application in a shared environment, measured from an ephemeral
CI runner, produces per-spec server reach on the hub's coverage page with no
network changes on either side; the same specs run locally with no hub still
produce their full report. The resolver's output for a recorded stream is
byte-identical whether executed by the CLI or by the hub's API.
