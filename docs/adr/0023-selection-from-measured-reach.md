# 0023. Spec selection reads measured reach, not a model's guess

- Status: accepted
- Date: 2026-08-17

## Context and problem statement

"Which specs does this diff affect" is answered today by a model reading the
diff and the spec inventory (ADR-0011). The model was the only option when
nothing knew what a spec actually touches: ADR-0011 rejected static
import-graph analysis because ccqa is product- and framework-agnostic, and
`relatedPaths` globs because humans cannot maintain them. Both rejections
stand — but the premise behind reaching for a model no longer does. Coverage
measurement (ADR-0021, ADR-0022) records, per spec, the files its execution
really reached, and stores that on the hub. The dependency edge ADR-0011
called nonexistent now exists as a measurement.

The model path also carries costs measurement does not: a Claude call per
deploy, answers that vary between runs on the same commit, and a structural
failure mode where a large diff or a truncated reply abandons the whole
selection to `unknown` — observed in practice as an entire suite left
undecided.

## Considered options

- **Keep the model**, feed it coverage as extra context.
- **Selection from measured reach**: a spec is needed when the diff
  intersects the file set its last measurement reached; the model path is
  removed.
- **Hybrid**: measured reach where edges exist, model for the rest.

## Decision outcome

Chosen option: "selection from measured reach", because an intersection over
measured facts is deterministic, free, and wrong in only one honest way —
staleness — which degrades to `unknown`, the vocabulary the pipeline already
treats as "run it".

The verdicts keep their meaning (ADR-0010/0011's ledger machinery is
untouched); only their source changes:

- **needed** — the diff touches a file the spec's most recent measurement
  reached. `touchedBy` names the intersection.
- **notNeeded** — the spec has a measurement and the diff misses all of it.
- **unknown** — the spec has no measurement to consult: never measured,
  measured longer ago than the hub retains, or the hub was unreachable. An
  unmeasured edge is not "unreached" — the two must never be conflated, so
  the absence of evidence runs the spec.

The mechanical pass stays ahead of everything, unchanged: a change to a
spec's own files or an included block marks it needed with no measurement
consulted, because reach cannot see the test's own definition. A diff with
no product changes still short-circuits to notNeeded across the board.

Edges come from the hub, from whichever source a project's runs feed: the
coverage event stream (`hub` inbox mode) and run report rows (`local` mode),
newest measurement per spec winning. Diff paths are re-rooted to the
measurement's own base (`coverage.projectRoot`) before intersecting — the
two sides must speak the same paths or every comparison silently misses.

File granularity over-selects: a change to a widely-imported file selects
every spec that reached it. That is the correct failure direction — the
model's failure direction was under- or non-selection — and finer
granularity (function-level measurement) narrows it later without changing
this decision.

This supersedes ADR-0011's mechanism, not its taste: static analysis and
path globs stay rejected for the reasons that ADR states.

### Consequences

- Good: selection is deterministic and reproducible from stored facts; the
  same commit always selects the same specs.
- Good: no Claude call in `select-specs` or `hub deploy record` — the cost
  and the abandoned-selection failure mode go with it.
- Good: the selection can say why, concretely: the intersecting paths are
  the reason, not a paragraph.
- Bad / cost: a project that has never measured coverage selects everything
  (`unknown` everywhere) until it runs `--coverage` once. That is the safe
  direction, and one measured run repairs it.
- Bad / cost: reach edges age. A spec's edge set is as fresh as its last
  measured run; the hub's retention bounds the stream at fourteen days, and
  a stale edge degrades to `unknown` rather than guessing.
- Follow-up: function-level granularity (measured, not decided here)
  narrows file-level over-selection.
- Follow-up: loading edges takes several bounded round trips to the hub,
  each failure degrading to `unknown`; folding them into one aggregate
  endpoint is worth doing once measured to matter, not before.

### Confirmation

On a project with measured coverage: a diff touching only files one spec
reaches selects exactly that spec plus the unmeasured; a docs-only diff
selects nothing; a diff touching a shared file selects every spec that
measured reach into it; with the hub unreachable, every spec degrades to
`unknown` and runs. The same inputs produce the same report on every
invocation.
