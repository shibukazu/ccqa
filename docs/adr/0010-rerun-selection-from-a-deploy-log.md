# 0010. Decide "needs re-run" from a deploy log the hub is told about

- Status: accepted (the selection input is superseded by ADR-0011)
- Date: 2026-07-25

> Amended by [ADR-0011](0011-replace-relatedpaths-with-model-selection.md):
> `relatedPaths` no longer exists. Wherever this record says the hub matches
> a deploy's changed paths against a spec's `relatedPaths`, the verdict now
> comes from `ccqa select-specs` and is recorded with the deploy. Everything
> else here — the deploy log, the ledger, the five states, position-based
> comparison — is unchanged.

## Context and problem statement

There is no way to tell which specs are worth running. A project either runs
everything (slow and, for live specs, expensive) or picks by hand and misses
things. The information needed to decide already exists but is scattered: the
hub knows each spec's `relatedPaths` (the perspectives document) and the
commit each spec last passed at (the last-green ledger), while the source
diff lives in a repository the hub cannot see.

The hub has no checkout and no `git`, and it must not call a git host's API —
that would bind ccqa to one host, require credentials the hub deliberately
does not hold, and break the CLI/hub split of ADR-0007. So the hub cannot
compute "did this spec's related code change?" on its own, yet the requirement
is that a user opening the Perspectives view sees, per spec, whether it should
be re-run, and can act on it there.

A further constraint makes the obvious shortcut unusable: ccqa is
product-agnostic, so it cannot assume `origin/main` is the ref to compare
against. Consumers use different default branches, release branches and
monorepo layouts. And an E2E spec exercises a *deployed environment*, not a
checkout, so the semantically correct baseline is the commit currently running
in that environment — which ccqa cannot know unless it is told.

## Considered options

- Have the hub compute the diff (clone the repo, or call a git-host compare
  API). Rejected: breaks product-agnosticism and ADR-0007, and needs
  credentials the hub does not hold.
- Have the CLI compute a staleness verdict periodically and push the result.
  Workable, but the verdict decays between probes (needing a `computedAt`, a
  self-invalidation rule and a scheduled job to stay honest), it duplicates
  the matcher on the CLI side, and — decisively — it still has to answer
  "which ref?", dragging in per-profile configuration, auto-detection and
  degradation paths.
- Have the deploy job push what it shipped: `{sha, previousSha, changedPaths}`.
  The hub folds that into a per-profile deploy log and answers "needs re-run?"
  by intersecting those paths with each spec's `relatedPaths`. (chosen)

## Decision outcome

Chosen option: "the deploy job pushes what changed", because the deploy job is
the only actor that has both the checkout and the sha transition, and because
this does not *solve* the "which ref?" problem so much as dissolve it — once
the deploy says what it shipped, there is no ref left to guess.

The rule this establishes, which the rest of the design follows from:

> ccqa never guesses the baseline. It is either told what the environment has
> (the deploy log), or told explicitly on the command line, or it reports
> `unknown`. No auto-detected default is presented as authoritative.

The hub's side of the work is set arithmetic over data it already stores, using
the same `isPathAffectedBy` matcher the CLI uses, so the two provably agree.
This is not a breach of the hub's "no compute" posture: ADR-0007 Axis 1 is
about external side effects — executing, touching the consumer repo, running
`git` or `gh` — and the hub already computes over its own storage (spec
counts, drift summaries, the ledger merge). Pure glob matching is the same
class.

### Vocabulary: "needs re-run" is not "freshness"

Two questions must not be conflated, and the words are reserved accordingly.

- **Freshness / drift** — *does this spec still describe the product
  correctly?* Semantic, answered by `ccqa drift` with a Claude call.
- **Needs re-run** — *is the last result still trustworthy?* Mechanical,
  answered by this feature with no model call.

The UI says "needs re-run", never "stale" or "fresh", and the stored state is
named for the action (`needed` / `notNeeded` / `unknown` / `neverRun`) rather
than for a freshness adjective, so the distinction survives in the schema and
not only in a label.

### Result and re-run are orthogonal axes

The last outcome and the need to re-run are independent, and the view shows
both rather than collapsing them (the same shape as ADR-0008):

|       | not needed                | needed                              |
| ----- | ------------------------- | ----------------------------------- |
| green | the only genuinely OK state | code moved under a passing test     |
| red   | known-broken, awaiting a fix | highest priority to re-run          |

The baseline is each spec's **last run of any non-skipped result**, not its
last green. A red spec's information is already current; re-running teaches
nothing new unless related code changed. Folding red into "needs re-run" would
park every chronically-failing spec at the top of the list forever, which is
the noise that kills this kind of feature.

### Selection and analysis are the same shape

The flag surface stays closed rather than growing a new concept. ccqa already
parameterises two operations by a baseline; this fills the empty cell instead
of adding a third vocabulary:

|            | fixed ref                  | per-spec, from the hub ledger    |
| ---------- | -------------------------- | -------------------------------- |
| selection  | `--changed <ref>`          | `--changed=last-run`             |
| analysis   | `--failure-analysis <ref>` | `--failure-analysis=last-green`  |

So there is no `--stale` flag. `--changed` gains the keyword `last-run`,
exactly as `--failure-analysis` already takes `last-green`, and the rule a user
has to remember collapses to one: both take a baseline, and a baseline is
either a git ref or a per-spec coordinate the hub tracks.

### States, and refusing to overstate

*(Superseded in 1.16 by [ADR-0014](0014-two-axes-one-verdict.md): the single
state below is split into an audit axis and an execution axis, with one verdict
derived from both. The deploy log, the ledger's three buckets, and the refusal
to overstate are unchanged — what follows describes the value they were
collapsed into.)*

Five states, and the view distinguishes all of them:

- `needed` — a deploy after the spec's last run touched its `relatedPaths`.
- `notNeeded` — no deploy since that point touched them.
- `unknown` — the question cannot be answered: no `relatedPaths` recorded, no
  deploy log for the profile, the run's deployed sha is unknown, ambiguous, or
  older than the retained log, or a gap or a truncated entry sits in the range.
  Each of those is a distinct machine-readable reason, because the fix differs
  (record a deploy, push a perspectives document, re-run the spec).
- `neverRun` — no run recorded for this spec and profile.
- `notEvaluated` — no data for this profile at all.

`unknown` is never rendered as "not needed", and always carries a
machine-readable reason so the view can say *why* ("no deploy log for `dev` —
wire `ccqa hub deploy record` into the deploy job") rather than shrugging.

### Scope key

`(project, profile, spec)`. Profile is mandatory: `dev` and `stg` are separate
deployments at different commits, so "needs re-run" has no profile-free answer,
and the deploy log is inherently per-profile. Target is not part of the key —
a spec resolves to exactly one generation target, so it adds no
discrimination.

### Consequences

- Good: the hub answers the question with data it already holds plus one new
  input, without git, a git host, or a guessed ref, and works for any branching
  model.
- Good: no new top-level command and no new selection concept — one keyword on
  an existing flag, plus `--dry-run`, plus a subcommand under the existing
  `ccqa hub` group.
- Good: selection happens inside `ccqa run`, so the shell-interpolation
  accident where an empty spec list silently means "run everything" cannot
  occur.
- Bad / cost: a profile whose deploy job is not wired shows `unknown`
  everywhere. That is the honest state, but it means the feature delivers
  nothing for that profile until the hook is added.
- Bad / cost: `relatedPaths` that are too narrow produce a confident
  "not needed" — the dangerous direction. Mitigated, not solved, by flagging
  patterns that match no file in the checkout (a directory walk, no model
  call), surfaced as a data-quality warning next to the verdict.
- Follow-up: teams with no deploy hook need an explicit
  `--changed=<ref>` escape hatch, which already exists; the ref is always
  supplied, never inferred.

### Implementation notes that are easy to get wrong

- Compare **positions in the deploy log**, not wall clocks. A run that started
  before a deploy and finished after it looks fresh by timestamp — an error in
  the unsafe direction. The run records the deployed sha it observed, and the
  comparison is an index comparison in a log the hub owns.
- The deploy hook must use a **two-dot** diff (`git diff --name-only A B`).
  Three-dot resolves the merge base and reports an empty diff on a rollback,
  making the rollback invisible. `getChangedFiles` in `src/drift/affected.ts`
  is three-dot — correct for its PR use case, wrong here; do not reuse it.
- A deploy entry whose `changedPaths` are absent or truncated is treated as
  touching everything. Fail-open and self-limiting: one over-broad deploy makes
  everything re-run once, then it settles.
- A `previousSha` that does not chain onto the log head records a gap, and any
  spec whose baseline sits behind a gap is `unknown`, not `notNeeded`.
- `ProjectConfigSchema` is `.strict()`, so adding a key to `.ccqa/config.yaml`
  breaks every older ccqa in the same repo. This design needs no project
  config; if one is ever added, relax that schema first, as a separate step.

### Confirmation

Phase 1 is verifiable without any of the deploy machinery: the ledger gains
last-run and last-red buckets, and the view shows the three coordinates for
specs that have run. Phase 2 is confirmed by recording a deploy that touches a
known spec's `relatedPaths` and observing that spec — and only that spec —
turn `needed`, then running it and watching it return to `notNeeded`.
