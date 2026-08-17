# Hub API

`ccqa serve` exposes a REST API under `/api/v1`. This is a **public contract**,
not an internal implementation detail: the ccqa CLI (`ccqa hub push`, and
`ccqa run`/`ccqa record` fetching sessions/variables/prompts at run time),
the hub's own bundled WebUI, and any other HTTP client (an intranet web app,
a script) all consume the exact same endpoints. The bundled UI has no
privileged access this API doesn't also grant everyone else — see
[`docs/hub.md`](./hub.md) for the architecture that guarantees this.

A typed TypeScript client is published at `ccqa/hub-client` (see
[TypeScript client](#typescript-client) below); this document is the
contract it wraps, for any other language or environment.

## Authentication

Every endpoint except `GET /api/v1/health` and `GET /` requires a bearer
token, set on the hub via the `CCQA_HUB_TOKEN` environment variable:

```
Authorization: Bearer <token>
```

Read-only `GET` endpoints (`artifacts/*`) additionally accept the token as a
`?token=` query parameter, since a browser `<a>` tag (the artifacts download)
can't set headers. This risks the token leaking via `Referer`, browser
history, or proxy logs — see [Security notes](#security-notes) for the full
tradeoff.

## Errors

Non-2xx responses are always:

```json
{ "error": { "code": "not_found", "message": "run \"abc\" not found" } }
```

## Runs

The hub never executes anything — a run is created when a client pushes the
report directory of an already-finished `ccqa run` as a gzip tar
archive. Every field of the resulting `Run` is derived server-side from that
report; a run is immutable once created (there is no update/patch).

```
POST /api/v1/runs?project=<name>&branch=<branch>&profile=<profile>&kind=<kind>&deployedSha=<sha>
  Content-Type: application/gzip
  body: gzip tar of a `ccqa run` output directory (must contain report.json)
  ?profile is optional — recorded on the Run for display; runs are not scoped by profile
  ?kind is optional — "run" (default), "drift" or "record"; only "run" is an executed run (see the `kind` field below)
  ?deployedSha is optional — the commit the environment was running; overrides the deploy log's head
  → 201 Run

GET /api/v1/runs?project=<name>&branch=<branch>&status=<status>&kind=<kinds>&since=<instant>&until=<instant>&limit=<n>
  ?kind is optional — a comma-separated list of kinds to keep (e.g. "run,drift")
  ?since / ?until are optional ISO-8601 instants bounding `createdAt`
  → 200 { runs: Run[] } | 400 (a `since`/`until` that is not an instant)

GET /api/v1/runs/:id
  → 200 Run | 404

GET /api/v1/runs/:id/report
  → 200 RunReportData (report.json bytes, unmodified) | 404

GET /api/v1/runs/:id/artifacts
  → 200 application/gzip (tarball of the run's full report directory) | 404

GET /api/v1/runs/:id/artifacts/*path
  → 200 (individual file — the hub UI fetches evidence PNGs this way) | 404
```

The listing's time window is compared against `createdAt` — the field the
listing also sorts by — and is half-open, `[since, until)`: to ask for one
day, pass that day's start as `since` and the next day's start as `until`,
and no run is counted twice at a boundary. Either end may be given alone.

As an alternative to the single-shot push above, a still-executing
`ccqa run` can stream results into the hub incrementally, spec by spec,
instead of waiting until it finishes:

```
POST /api/v1/runs/open?project=<name>&branch=<branch>&profile=<profile>&kind=<kind>&gitHead=<sha>&deployedSha=<sha>
  (same query params as POST /api/v1/runs plus optional gitHead, no body)
  → 201 Run   (status: "running")

PATCH /api/v1/runs/:id
  Content-Type: application/json
  body: {
    rows: ReportSpecResult[],
    evidence?: Record<string, string>,  // relative path -> base64 file bytes
    done?: boolean,
    finalStatus?: "passed" | "failed",
    reportMeta?: Partial<ReportEnvelope>,
  }
  → 200 Run | 404 (no such run) | 409 (run is not currently "running")
  Spec rows upsert into report.json's `results`, keyed by feature/spec — safe
  to resend the same row. Evidence files are written individually, not as a
  re-upload of the whole tarball. `done: true` seals the run to `finalStatus`
  if given, else `specs.failed > 0 ? "failed" : "passed"`.
```

```ts
interface Run {
  id: string;
  project: string;
  profile: string | null;    // which profile/environment the run executed against; display-only
  branch: string | null;
  status: "passed" | "failed" | "running";
  kind: "run" | "drift" | "record";  // which command left the run — see below
  drift: { specs: number; testDrift: number; specChange: number; unknown: number } | null; // set only for kind: "drift"
  specs: { total: number; passed: number; failed: number };
  gitHead: string | null;
  promptVersion: string;
  costUsd?: number | null;   // total Claude spend, from the report's cost.totalCostUsd
  ciRunId: string | null;    // from the report, e.g. GITHUB_RUN_ID; null when run locally
  reportCreatedAt: string;   // when the underlying `ccqa run` actually executed
  createdAt: string;         // when the hub accepted the push
  deployedSha?: string | null;                          // the commit the environment was running (see Deploys)
  deployedShaSource?: "hub-deploy-log" | "client" | null;
  deployedShaAmbiguous?: boolean;                       // the deploy-log head moved while the run was open
}
```

`branch` defaults from the pushing client (`ccqa hub push` / `ccqa audit --report-to-hub`
resolve `$GITHUB_HEAD_REF` → `$GITHUB_REF_NAME` → the local git branch), and is
`null` if the client sent none. `status` is `"passed"`, `"failed"`, or
`"running"` — `running` never means the hub itself is executing anything;
it only means a `ccqa run` elsewhere is currently streaming results into
this run record via `POST /api/v1/runs/open` and `PATCH /api/v1/runs/:id`.
`drift` is derived from the pushed report's `results[].analysis` (present only
for `kind: "drift"` runs, where each row's `analysis` is a labelled
`TEST_DRIFT`/`SPEC_CHANGE`/`UNKNOWN` diagnosis rather than a triage call) and
is `null` for every other kind.

`kind` names the command that left the run: `"run"` is `ccqa run`, `"drift"`
is `ccqa audit --report-to-hub`, and `"record"` is
`ccqa record --report-to-hub`. Only `"run"` executed anything. A `"record"`
run carries one row — the spec that was recorded — and exists so that a
budget summed over `costUsd` sees what re-recording cost; it advances no
ledger, because recording a test is not a verification of the product. Its
`specs` counts are about that one row and answer nothing about a spec's
health.

`costUsd` is what the run spent on Claude, taken from the pushed report's
`cost.totalCostUsd`. It counts everything the invocation billed — live
browsing, failure triage, the drift audit a failure triggers, and spec
selection — so it is a superset of the per-step costs inside `results[]`, not
a sum of them. Like every other field it is derived server-side from the
report; a client-supplied number is never trusted. It is `null` when the run
billed nothing (a deterministic run that passes calls Claude nowhere), and
absent on runs stored before this field existed — which is why it is optional.
On an incrementally-streamed run it is refreshed from every `PATCH` whose
`reportMeta` carries `cost`, which is what lets a run killed mid-flight still
report what it burned.

One call falls outside it: `ccqa run --learn-hub-live-prompt` refreshes the
prompt after the run is sealed, so that spend reaches the client's `[cost]`
line but never this field. A run that used the flag is understated here by
one prompt-learning call.

A run opened via `POST /api/v1/runs/open` accepts repeated `PATCH` calls
while it's `running`: each one upserts spec rows (by feature/spec) and adds
evidence files incrementally. A `PATCH` with `done: true` seals the run to
`passed`/`failed`; any `PATCH` after that returns `409`, matching the
existing rule that a terminal run is immutable. If the hub process itself
restarts while a run is still `running` (e.g. it crashed or was redeployed
mid-run), a one-time startup sweep flips every such orphaned run to
`"failed"`, since nothing will ever resume patching it.

Runs are not kept forever. Each time one reaches a terminal state, its
`(project, branch)` is trimmed to the newest 200 (`ccqa serve
--max-runs-per-branch <n>`), and every dropped run's record, artifacts and
triage records go together — so `GET /runs/:id` and everything under it answer
`404` for it afterwards. Ledger entries are not rewritten, so `/last-green`,
`/rerun` and `/drift` can hand back a `runId` that no longer resolves; nothing
they compute reads that id (see [docs/hub.md](./hub.md#run-retention)).

## Triage

Each failing spec's classification pairs an AI **prediction** (read-only,
sourced from the run's report) with a human-recorded **actual cause**
(write-only from the client's perspective). One vocabulary of four causes —
`TEST_DRIFT` / `SPEC_CHANGE` / `PRODUCT_BUG` / `ENVIRONMENT` — is shared by
both callers; a `kind: "drift"` row (the audit) can only ever carry the
first two, since it never opens a browser. See [Failure
triage](./running.md#failure-triage) and [Drift
detection](./running.md#drift-detection).

```
GET /api/v1/runs/:id/triage
  → 200 {
      runId, promptVersion,
      cases: [{ feature, spec,
                target?,                 // generation target of the graded row (e.g. "playwright"); omitted for agent-browser
                predicted: { label, confidence, subDiagnosis?, headline },
                actual: { cause, note?, recordedAt, invalidForKind? } | null }],
      recorded: number, recordedInvalidForKind: number, total: number
    }
  `invalidForKind` marks a grade whose `cause` is not one this row's kind
  accepts (e.g. `NO_DRIFT` on a `kind: "run"` row). Such a row is excluded
  from the confusion matrix and from every learning job, and counted in
  `recordedInvalidForKind` rather than `recorded`, so a reader can see how
  much of the history stopped counting instead of watching accuracy fall
  for no stated reason. Nothing converts it — regrade it.

PUT /api/v1/runs/:id/triage/:feature/:spec/actual-cause
  body: { cause: "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG"
               | "ENVIRONMENT" | "NO_DRIFT", note?: string }
  → 200 TriageCase | 400 (cause not valid for this row's kind)
    | 404 (no such case) | 409 (run has no report yet)
  Which causes are valid depends on the row's kind: a `kind: "run"` row
  takes "TEST_DRIFT" / "SPEC_CHANGE" / "PRODUCT_BUG" / "ENVIRONMENT" — a run
  answers all four; a `kind: "drift"` row takes "TEST_DRIFT" / "SPEC_CHANGE"
  / "NO_DRIFT" — the audit never opens a browser, so it can't say the
  product broke or the environment failed.
  "NO_DRIFT" records that an audit reported drift where there was none. It is
  offered on `kind: "drift"` rows only — a failing test always has a cause.

DELETE /api/v1/runs/:id/triage/:feature/:spec/actual-cause
  → 204

PUT /api/v1/runs/:id/triage/actual-causes
  body: LabelsExport JSON
  → 200 { imported: number, rejected: [{ feature, spec, reason }] }
  Bulk-import path for a batch of graded actual-causes (e.g. from external
  tooling). Each entry is validated against its own row's kind, the same way
  the single PUT is, and an entry that names no matching row or an invalid
  cause is returned in `rejected` rather than dropped — a count alone cannot
  tell "imported 8 of 10" from "imported 8, silently lost 2".
```

Grading a `kind: "drift"` row also corrects that spec's entry in the drift
ledger, so the Perspectives view shows what the human decided rather than what
the audit guessed — but only while the entry still names this run, so a
correction to an old verdict cannot overwrite a newer audit. The run itself is
never rewritten: it keeps the audit's counts in `drift`, and a `gradedDrift`
object is joined on when the run is read, present once any row is graded.

## Projects

One hub manages many projects (one per consuming `.ccqa` tree). Projects are
implicit — pushing a run or storing a secret under a name creates it; when
nothing references the name anymore it disappears. Runs take the project as
an optional `?project=` **filter**; sessions and variables take it as a
required **path segment**, because a secret always belongs to exactly one
project.

```
GET /api/v1/projects
  → 200 { projects: string[] }   (distinct names across runs, sessions, variables, and prompts)

GET /api/v1/projects/:project/profiles
  → 200 { profiles: string[] }   (distinct profiles across the project's sessions + variables;
                                   "default" always included. Prompts/runs are not profile-scoped.)

GET /api/v1/projects/:project/last-green?profile=<name>&branch=<branch>&fallbackBranch=<branch>
  → 200 {
      entries: { "<feature>/<spec>": SpecLedgerEntry },      // last green — unchanged meaning
      lastRun: { "<feature>/<spec>": SpecLedgerEntry },      // last non-skipped execution
      lastRed:  { "<feature>/<spec>": SpecRedLedgerEntry },  // last failure
    }

interface SpecLedgerEntry {
  gitHead: string; runId: string; at: string;
  deployedSha?: string | null;        // the commit the environment was running (see Deploys)
  deployedShaAmbiguous?: boolean;     // the run straddled a deploy
}

interface SpecRedLedgerEntry extends SpecLedgerEntry {
  label?: "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG" | "ENVIRONMENT" | "UNKNOWN";
  headline?: string;                  // the analysis' single-sentence conclusion
}
```

`last-green` serves the per-spec ledger behind
`ccqa run --on-fail-explain`: for each spec, the head sha of the
run in which it last passed. The hub advances the ledger whenever a
`kind: "run"` run reaches a terminal state — every executed spec's entry
moves to that run's `gitHead` (newest `at` wins). A **skipped** row did not
execute and advances nothing. Entries are scoped by
project/profile/**branch**; the response overlays the `branch` bucket onto
the optional `fallbackBranch` bucket (typically the default branch), so a PR
branch inherits the default branch's baselines while its own greens take
precedence — and a PR-branch green never contaminates the default branch's
bucket. `profile` defaults to `"default"`; `branch` is required.

`entries` keeps its original meaning (last green) so older clients keep
working; `lastRun` and `lastRed` are siblings, not a redefinition.
`lastRun` — not `lastGreen` — is the baseline for re-run selection: a red
spec's information is already current, so re-running it teaches nothing
until related code moves.

Only the red bucket carries a cause: `label` and `headline` are copied from
the run report's failure analysis, so a reader learns why a spec is red
without fetching a report per spec. A pass has no cause, which is why the
other two buckets do not carry the fields. Both are optional and absent for
the same reason — nothing is on record: the run was made without
`--on-fail-explain` (analysis is opt-in), the analysis produced no headline,
or the entry was written before these fields existed. Ledgers written by an
older hub keep working untouched: the fields appear on red entries written
from then on, and nothing rewrites the ones already stored.

## Deploys and re-run selection

The hub has no checkout, never runs `git`, and never calls a git host, so it
cannot work out what a deploy changed or which specs it reaches. The
consuming deploy job tells it both: the changed paths, and (optionally) which
specs `ccqa select-specs` decided the deploy reaches (ADR-0010, ADR-0011).
The hub answers "which specs are worth running?" as set arithmetic over that
log, the spec ledger, and the per-deploy selections submitted alongside it —
the hub itself makes no model call.

```
POST /api/v1/projects/:project/deploys?profile=<name>
  Content-Type: application/json
  body: {
    sha: string,
    previousSha?: string | null,   // the commit replaced; omit it and the entry records a gap
    changedPaths?: string[] | null, // from a TWO-dot diff (`git diff --name-only A B`)
    selection?: { "<feature>/<spec>": DeploySelectionEntry },  // from `ccqa select-specs`
    ref?: string,
    runUrl?: string,
  }
  → 201 DeployEntry

GET /api/v1/projects/:project/deploys?profile=<name>&limit=<n>
  → 200 { entries: DeployEntry[], nextIndex: number }   (oldest first)

GET /api/v1/projects/:project/rerun?profile=<name>
  → 200 {
      project, profile,
      deployHead: { index, sha, at } | null,
      specs: { "<feature>/<spec>": SpecRerun },
    }
  | 404 (the project has no perspectives document)

GET /api/v1/projects/:project/audit-needed?profile=<name>
  → 200 {
      project, profile,
      specs: { "<feature>/<spec>": AuditNeed },
    }
  | 404 (the project has no perspectives document)

POST /api/v1/projects/:project/locks?profile=<name>
  { specs: string[], kind: "audit" | "run", holder: string, ttlSeconds: number }
  → 200 { granted: string[], denied: string[] }
  # keys are "<feature>/<spec>", or "resource:<name>" for a `serialGroups`
  # name — the same claim, over a thing rather than a spec

DELETE /api/v1/projects/:project/locks?profile=<name>
  { holder: string }
  → 204
```

```ts
interface AuditNeed {
  because: "neverAudited"    // no baseline at all, so no diff can narrow it away
         | "deployReached"   // a deploy landed on code this spec covers
         | "cannotTell"      // the deploy log has a hole; `reason` names it
         | "held"            // another job is auditing it right now
         | "current";        // audited at the deployed commit, nothing since
  reason?: /* same set as SpecRerun.auditAssumedReached */;   // set only when because is "cannotTell"
}
```

`--only-hub-audit-needed` audits everything but `current` and `held`. It used
to default the opposite way from `--only-hub-rerun-needed` on a hole in the
deploy log — audit costs cents, a live run costs dollars, so the audit did the
work and the run declined it. That gap is closed now: both treat an
unplaceable range as reached (ADR-0014), so the two differ in wording, not in
what they select.

The client also reads the drift ledger and audits any spec whose entry is
still open, regardless of the answer above. The union happens client-side —
`because` stays a closed enum on the wire, so an older hub keeps working.

A **claim** stops a second job starting on a spec the first is still working.
It is not a value on either axis — the axes describe recorded facts, work in
flight needs a lifetime, and the same mechanism covers both jobs. A claim
lapses rather than being reaped: `expiresAt` is compared on every read, so a
job killed without releasing frees its specs by itself, at the cost of holding
them until it passes. Pick `ttlSeconds` from how long the caller's own work can
take. Re-asking with the same `holder` extends the claim; releases are keyed by
holder, so a late one from a lapsed job cannot take a claim the next job has
since acquired.

A claim key is usually a spec, but `ccqa run` also claims a `resource:<name>`
key for every `serialGroups` entry its specs belong to, so two jobs running
*different* specs still take turns on the thing both write to (ADR-0015). A
denied resource drops every spec needing it from that cycle.

```ts
interface DeployEntry {
  index: number;              // monotonic position — the only ordering used
  sha: string;
  previousSha: string | null;
  at: string;
  ref?: string;
  runUrl?: string;
  changedPaths: string[] | null; // record-only; verdicts read hasSelection, not this
  hasSelection: boolean;      // whether `selection` was supplied alongside changedPaths
  gapBefore: boolean;         // previousSha did not chain onto the log head
}

interface DeploySelectionEntry {
  verdict: "needed" | "notNeeded" | "unknown";
  reason: string;
  touchedBy?: string[];        // changed paths the selector tied to this spec; set for "needed"
}

interface SpecRerun {
  // The one answer, derived from the two axes below plus whether a claim is
  // held. Named for who acts next.
  verdict: "inProgress"     // a claim is held, or the audit has not caught up
         | "needsRepair"    // a person: drift, an undecided audit, or a failed run
         | "rerunNeeded"    // cleared by the audit, and the last result is out of date
         | "verified";      // cleared by the audit, and the last run passed against this deploy

  // Axis 1 — what the audit says about the *deployed* commit.
  audit: "due"          // owed an answer: never audited, audited at an older
                         // commit, or the log can't place the audit — an
                         // unplaceable range is assumed reached (see below)
       | "clean"
       | "drifted"      // `driftLabel` names which kind
       | "undecided";   // the audit read the code and could not decide
  driftLabel?: "TEST_DRIFT" | "SPEC_CHANGE";   // set only when audit is "drifted"

  // Axis 2 — how the last execution ended, and whether it still covers what
  // is deployed.
  execution: "passed"    // the last run passed, against the commit deployed now
           | "failed"    // the last run failed
           | "stale"     // a deploy has reached the spec since the last run —
                         // or the log can't place the run; same treatment
           | "neverRun"; // no run at all

  // The job working on it right now, or null. An expired hold reads as null.
  heldBy: { kind: "audit" | "run", holder: string, expiresAt: string } | null;

  // Set only when `audit`/`execution` landed on "due"/"stale" because the log
  // couldn't place the audit/run, not for the ordinary reasons. Both can be
  // set at once. `unknownDeployedSha`/`ambiguousDeployedSha` describe the
  // *run's* deployed sha, so only `executionAssumedReached` carries them.
  auditAssumedReached?: "noSelectionInRange" | "selectionUnknown" | "noDeployLog"
                       | "deployedShaNotInLog" | "gapInRange";
  executionAssumedReached?: /* same set as auditAssumedReached, plus */
                            "unknownDeployedSha" | "ambiguousDeployedSha";
  lastRun: SpecLedgerEntry | null;
  lastGreen: SpecLedgerEntry | null;
  // Carries the failure's `label`/`headline` when one was recorded, so
  // `execution: "failed"` can be shown with its cause (see `last-green`).
  lastRed: SpecRedLedgerEntry | null;
  touchedBy?: string[];       // up to 10 matched paths; set only when execution is "stale"
  touchedByDeploy?: { index, sha, at } | null;  // the deploy that made it "stale"
}
```

Neither axis determines the other — a spec can be clean and stale, or
drifted and freshly run — so they are carried apart and the verdict is derived
from both. Exactly one verdict, `needsRepair`, asks for a person; a reader
scanning a list of specs only has to look for that one.

A failed spec is `needsRepair` and is never offered for a re-run: repeating it
teaches nothing until the code it exercises moves or the spec is fixed, and a
live spec costs dollars a go. A spec that has never run is `rerunNeeded` — no
result at all is as uncovered as a result a deploy invalidated.

`touchedByDeploy` names the newest deploy *in the run's range* whose
changes matched the spec — the deploy that made it `stale`, which is not the
same coordinate as `deployHead` (only the point the judgement was made at). It
is additive and optional: an older hub omits it. It is null when the entry that
proves the touch is no longer retained in the log — the verdict still stands on
the touch index's recorded position, but the deploy cannot be named without
overstating.

Use a **two-dot** diff in the deploy hook. Three-dot resolves the merge base
and reports an empty diff on a rollback, which would make the rollback
invisible.

Comparisons are positions in the deploy log, never wall clocks: a run that
started before a deploy and finished after it looks up to date by timestamp,
which is wrong in the unsafe direction. The hub stamps `Run.deployedSha`
from the profile's deploy-log head when a run is created or opened, and sets
`deployedShaAmbiguous` when the head moved before the run was finalized.
Pass `?deployedSha=` on `POST /runs` or `POST /runs/open` to assert it
instead — a single-shot push reaches the hub only after the run is over, so
a deploy that landed mid-run would otherwise read as that run's baseline.

A deploy recorded without a selection (`hasSelection: false`) is a hole in the
range: specs whose baseline sits behind it are assumed reached — `stale`, not
`verified` — until a later deploy resolves them. That is the safe default (a
spec run needlessly costs a run, a spec skipped silently costs the release),
but the cost is real: it takes a full audit sweep and a full run of every spec
behind the hole to close it, and auditing first does not shrink that, because
the execution axis stays `stale` regardless of what the audit answers.
`changedPaths` is record-only and plays no part in this. `profile` is part
of the scope key and defaults to `"default"`: a spec run under one value set
says nothing about another, so "needs re-run" has no profile-free answer.
Branch is not part of the scope — a run exercises the deployed environment
whatever branch its code came from, so the ledger is read across every branch
of the profile.

### Manual attestations

```
GET    /api/v1/projects/:project/attestations?profile=
PUT    /api/v1/projects/:project/attestations?profile=     { "spec": "feature/spec", "by": "...", "note": "..." }
DELETE /api/v1/projects/:project/attestations?profile=     { "spec": "feature/spec" }
```

An attestation is a person's word that they checked a spec's behaviour by
hand against the deployed environment. It overrides the **verdict**, never
the ledgers: the drift entry that parked the spec stays open, so the repair
loop keeps its reason to fix the test, while `/rerun` answers
`manuallyVerified` instead of asking a person for what a person already did.
The run side never selects a `manuallyVerified` spec — the test is still the
broken one the attestation stands in for.

The hub stamps the time and the profile's current deploy head; the caller
sends only `spec`, `by` and an optional `note`. One attestation per spec — a
new one replaces the old. It lapses on its own, judged by the same yardsticks
a run's currency is: a deploy reaching the spec, the spec's own text being
edited after the person looked, a run failing after them, or a deploy head
the log cannot place (assumed reached, ADR-0014). A lapsed attestation is not
dropped from `/rerun`: the row carries it as `manualLapsed` with a `because`
naming which of those ended it (`deployReached` | `cannotPlace` |
`specEdited` | `newerRed`), plus `manualLapsedByDeploy` naming the deploy
when the log can, and `manualLapsedReason` naming which hole when the log
could not place it — the person deciding whether to attest again needs to
know what changed since they last looked. A standing one rides as `manual`
whether or not it decided the verdict: on a held or machine-verified spec it
changed nothing, but it is still there to be seen and revoked.

`GET` returns the raw document, standing and lapsed alike — whether one still
covers its spec is `/rerun`'s answer; the raw read exists so a lapsed
attestation can still be found and revoked. `DELETE` of a spec with no
attestation succeeds: the caller asked for its absence, and it is absent.

### Audit dismissals

```
GET    /api/v1/projects/:project/audit-dismissals
PUT    /api/v1/projects/:project/audit-dismissals   { "spec": "feature/spec", "by": "...", "note": "..." }
DELETE /api/v1/projects/:project/audit-dismissals   { "spec": "feature/spec" }
```

A dismissal is a person's answer to one audit finding: the spec describes the
code fine, and the finding is wrong. Where an attestation speaks about the
product, this speaks about the **audit** — so it settles the audit axis
(`clean`) rather than overriding the verdict, and the spec goes back to being
run like any other. The run that follows is what says whether the person was
right.

No `?profile=`: an audit finding is about the repository, not an environment,
the same reason the drift ledger has none.

The hub reads which finding is being answered from the ledger and pins the
dismissal to that audit run — the caller sends only `spec`, `by` and a
required `note` (the correction a mis-firing audit learns from). A spec with
no open finding is rejected with `no_open_finding`: there would be nothing to
answer, and the record would never apply to anything.

A later audit is a new observation of newer code, so it produces a new run and
the dismissal stops applying — the machine gets to raise the finding again
rather than being silenced for good. `/rerun` ships the dismissal as
`auditDismissed` either way, and the axis beside it says which case it is:
`clean` means the dismissal settled it, `drifted`/`undecided` means a later
audit raised something the dismissal does not answer for, shown so the reader
knows the argument has been had before.

## Drift ledger

Every spec's last `ccqa audit --report-to-hub` audit, so a project can be reviewed
without opening each drift run individually. Unlike `/rerun` and
`/last-green` above, this endpoint takes **no `?profile=`**: drift asks
whether a spec still describes the code, which has nothing to do with which
environment is running it.

```
GET /api/v1/projects/:project/drift
  → 200 { project: string, specs: { "<feature>/<spec>": SpecDriftEntry } }
```

```ts
interface SpecDriftEntry {
  label: "TEST_DRIFT" | "SPEC_CHANGE" | "UNKNOWN" | null;  // null = audited, no drift found
  surface?: "spec" | "generated";  // set only when label is non-null
  subDiagnosis?: "SELECTOR_DRIFT" | "OVER_ASSERTION" | "NONE";  // the diagnosis's finer-grained kind
  specChangeKind?: "FEATURE_REMOVED" | "BEHAVIOUR_CHANGED";  // set only on SPEC_CHANGE
  confidence?: number;
  headline?: string;
  gitHead: string;   // the commit this audit read
  runId: string;      // the kind: "drift" run this entry came from
  at: string;         // the run's reportCreatedAt — the ordering key for ledger updates
}
```

The hub advances the ledger whenever a `kind: "drift"` run reaches a
terminal state: each row's `analysis` becomes that spec's newest entry —
`label: null` when the audit found no drift, the labelled diagnosis
otherwise. A spec with **no entry at all** was simply never audited; that is
a different state from `label: null` and the two must not be conflated. A
**skipped** row advances nothing, leaving whatever entry the spec already
had (including none). Entries are scoped by project/**branch**; the response
merges every branch, newest `at` per spec winning — the same approximation
`/last-green`'s `getMerged` read makes.

`subDiagnosis` carries the diagnosis's finer-grained kind (e.g. selector
drift vs over-assertion on a `TEST_DRIFT`), so a consumer can branch on which
repair a drifted spec needs. It is absent on entries written before the field
existed and on clean audits.

`specChangeKind` names which repair a `SPEC_CHANGE` needs: `FEATURE_REMOVED`
means the behaviour the spec checks is gone from the code, so the spec goes
with it, and `BEHAVIOUR_CHANGED` means it still exists but works differently,
so the spec is rewritten and re-recorded. It is **absent** on every other
label, and also on a spec change the audit could not read either way — there
is no third value, so a consumer must leave an absent one to a human rather
than defaulting to either repair.

## Acks

A named set of opaque keys a consumer has already **acted on**, scoped by
project/profile. A consumer that reports the hub's verdicts onward — telling
a human, opening a ticket, whatever it does — needs to know what it already
handled, so it can send only what is new; a CI job has no memory across runs,
and the hub is the only durable thing in the loop. The set is opaque to the
hub: the consumer picks the name, decides what "acted on" means, and does its
own comparing.

```
GET /api/v1/projects/:project/acks/:name?profile=<name>
  → 200 { project, profile, name, keys: string[], at: string | null }

PUT /api/v1/projects/:project/acks/:name?profile=<name>
  Content-Type: application/json
  body: { keys: string[] }
  → 200 { project, profile, name, keys, at }   (`at` is the write time)
```

`profile` defaults to `"default"`. `name` must be a bare name (letters,
digits, `.`, `_`, `-`), like a session's.

A `GET` of a name that was never written returns an **empty set** with
`at: null`, not a `404` — "nothing acted on yet" is the honest answer on a
first run. `PUT` replaces the set wholesale rather than applying a delta, so
the consumer sends what it holds now; `keys: []` resets. There is no
`DELETE`, and the hub computes no diff — only the consumer knows what to do
with the difference.

**Write after acting, never before.** The `PUT` records what was successfully
acted on; issuing it first would mark a failed send as delivered and the item
would never be mentioned again.

Bounds: at most 5000 keys, each at most 256 characters. Both sit far above
any real project and exist only to stop a malformed client writing an
unbounded document.

## Spend

What one batch of ccqa invocations cost on Claude, as the job that ran them
reported it. `ccqa hub cost push` is the client for this: it sums the JSONL
every command appends to `$CCQA_COST_FILE` and posts a single entry.

**A budget reads this, not runs.** Only `run`, `audit --report-to-hub` and
`record --report-to-hub` leave a run behind, so a cap computed by summing
`Run.costUsd` cannot see the rest of what calls Claude — the coverage-inventory
refresh, the spec rewrite a fix loop makes before re-recording, the spec
selection a deploy record runs, an audit that deliberately publishes nothing. A
reported batch covers its whole job **including** the run and the audit inside
it, so a consumer that adopts the spend log must stop summing runs; adding both
counts those twice. Runs keep `costUsd` for their own display.

```
POST /api/v1/projects/:project/spend
  Content-Type: application/json
  body: { costUsd: number, label: string, at?: string, ciRunId?: string, runUrl?: string }
  → 201 SpendEntry | 400 (an `at` that is not an ISO-8601 instant)

GET /api/v1/projects/:project/spend?since=<instant>&until=<instant>
  → 200 { project, since, until, totalUsd, entries: SpendEntry[] }   (newest first)
  → 400 (a `since`/`until` that is not an instant)
```

```ts
interface SpendEntry {
  id: string;
  at: string;        // defaults to the time of the POST; stored in UTC
  costUsd: number;
  label: string;     // what the batch was, in the consumer's words: its job name
  ciRunId?: string;  // the CI run that produced it
  runUrl?: string;
}
```

No `?profile=`: a batch is one job's bill, and a job can touch several
environments. The window is the same half-open `[since, until)` the runs
listing takes, compared against `at`; either end may be given alone, and
`totalUsd` totals exactly the entries returned.

A push carrying the same `ciRunId` and `label` as a stored entry **replaces**
it rather than adding to it: a retried job spends again, but it also rewrites
its cost file from scratch, so its later total is the whole of that job — and
a workflow that pushes twice by accident cannot silently double the project's
bill, which no later request could detect or undo. Outside CI there is no
`ciRunId`, and every push is its own entry.

Entries older than **90 days** are dropped as the log is appended to. The
document is otherwise append-only, and a budget only ever asks about the recent
past — an unbounded one would make every read slower for entries nobody asks
about.

One known weakness: a job killed before it reports loses its whole total, and
the budget never sees that job at all. There is no incremental variant. Push
once at the end of the job, and run that step unconditionally (GitHub Actions:
`if: always()`) so a failing job still reports what it spent. A job killed
mid-write leaves a half-written last line in the cost file, which
`ccqa hub cost push` counts and warns about: the entry it sent is then a floor
rather than the whole bill.

## Sessions

Saved browser sessions (agent-browser storage state), scoped by
project/profile. `GET .../sessions/:profile/:name` is a **real read** — it
returns the decrypted session contents, not metadata. Any holder of
`CCQA_HUB_TOKEN` can call it, which is exactly what `ccqa run`/`ccqa record`
rely on to fetch a session directly at run time. See [Security notes](#security-notes).

```
PUT /api/v1/projects/:project/sessions/:profile/:name
  Content-Type: application/json
  body: raw agent-browser storage-state JSON
  → 204 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

GET /api/v1/projects/:project/sessions/:profile
  → 200 { sessions: [{ name, updatedAt }] }   (metadata only)

GET /api/v1/projects/:project/sessions/:profile/:name
  → 200 (decrypted storage-state JSON) | 404 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured)

DELETE /api/v1/projects/:project/sessions/:profile/:name
  → 204
```

## Variables

Environment variables fetched directly into a run via `--hub-profile`, scoped
by project/profile. Non-sensitive values are always readable back (useful
for a dashboard to display current config). `sensitive: true` values are
hidden from the plain listing, but **not** from `?include=values` — that
query param is a real read of every value, sensitive or not, and is what
`--hub-profile` resolution uses.

```
PUT /api/v1/projects/:project/variables/:profile/:name
  body: { value: string, sensitive: boolean }
  → 204 | 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

GET /api/v1/projects/:project/variables/:profile
  → 200 { variables: [{ name, sensitive, updatedAt, value? }] }
  `value` is present only when sensitive is false.

GET /api/v1/projects/:project/variables/:profile?include=values
  → 200 { variables: [{ name, sensitive, updatedAt, value }] }
  `value` is present for every variable, including sensitive ones.
  → 503 (CCQA_HUB_ENCRYPTION_KEY not configured on the hub)

DELETE /api/v1/projects/:project/variables/:profile/:name
  → 204
```

Sessions and variables both require `CCQA_HUB_ENCRYPTION_KEY` to be
configured on the hub (they're stored AES-256-GCM encrypted at rest) — `PUT`,
and any `GET` that returns a decrypted value, return `503` otherwise.

## Prompts

Prompt assets (guidance prompts and learned calibration notes), scoped
by **project only** — unlike sessions and variables, prompts are project-wide,
not per-profile (the same guidance applies across every profile a project runs
against). Prompts are **not encrypted** and require no
`CCQA_HUB_ENCRYPTION_KEY` — they are plain text, not secrets. `name` must be
one of the reserved prompt names — a `<kind>.user` / `<kind>.agent` pair for
`record`, `live`, `playwright`, `runn`, `triage`, and `audit`. `triage.user`
/ `audit.user` are human-written classification guidance for the run and the
audit respectively; `triage.agent` / `audit.agent` are the learned
calibration notes a [learning job](#learning-jobs) writes. Anything else is
`400`.

```
PUT /api/v1/projects/:project/prompts/:name
  Content-Type: text/markdown or application/json (name-dependent)
  body: prompt text (Markdown for guidance names; JSON for the two learned
        calibration notes, "triage.agent" / "audit.agent")
  → 204 | 400 (unknown prompt name)

GET /api/v1/projects/:project/prompts
  → 200 { prompts: [{ name, kind, updatedAt, meta }] }   (metadata only)

GET /api/v1/projects/:project/prompts/:name
  → 200 (raw prompt body, text/markdown or application/json) | 404

DELETE /api/v1/projects/:project/prompts/:name
  → 204
```

## Perspectives

The project's coverage-inventory document (`ccqa perspectives`), stored on
the hub only — one JSON document per project, plain text, no encryption key
required. The CLI Zod-validates before pushing; the hub only rejects bodies
that aren't a JSON object. Each spec entry may carry `steps`, the spec's
procedure transcribed verbatim (an include step keeps only its block name)
so the hub UI can show a case in full — a mechanical copy like `title`,
rewritten wholesale on every regeneration, never authored. `PATCH` is the hub UI's note editing: `note` is
the document's only human-authored field and this is its only write path
(an empty `note` clears the field). The edit is applied as a serialized
read-modify-write so concurrent edits can't clobber each other.

```
PUT /api/v1/projects/:project/perspectives
  Content-Type: application/json
  body: the perspectives document (schema: src/spec/perspectives-schema.ts)
  → 204 | 400 (not a JSON object)

GET /api/v1/projects/:project/perspectives
  → 200 (application/json, the stored document) | 404

PATCH /api/v1/projects/:project/perspectives
  Content-Type: application/json
  body: { feature, spec, note }
  → 204 | 400 (malformed body) | 404 (no document, or no such spec entry)

DELETE /api/v1/projects/:project/perspectives
  → 204
```

## Coverage inbox

The append-only coverage event stream (ADR-0022): instrumented applications
and the run both append; the hub stamps arrival order, stores each event
encrypted at rest, and interprets nothing at write time. Interpretation is
`GET /api/v1/coverage`, which replays one run's view of the stream through
the shared resolver on read — the same function the CLI runs locally — and
caches the answer keyed by stream position.

Appending accepts a second credential: `CCQA_HUB_COVERAGE_TOKEN`, set on
`ccqa serve`, authorizes application pushes and nothing else — it cannot
read, and it cannot write the run's own marker events, so the credential a
deployed application holds can at worst inject fake measurements. The hub's
bearer token accepts every event kind. Both require the encryption key:
actor events can carry identity tags, so the stream is never stored in the
clear.

```
POST /api/v1/coverage/events?project=<name>
  Content-Type: application/json
  body: an application push (protocol: 1, the collector's wire shape) or a
        run event (schema: src/coverage/events.ts)
  → 204 | 400 (malformed) | 401 | 403 (append token sent a run event)
      | 503 (no coverage token / no encryption key configured)

GET /api/v1/coverage/events?project=<name>&sinceSeq=<n>
  bearer token only
  → 200 { events, lastSeq, skipped }

GET /api/v1/coverage?project=<name>[&runId=<id>]
  bearer token only; runId defaults to the stream's most recent run
  → 200 { resolved, runIds }   (resolved is null on an empty stream;
      schema: src/coverage/resolve-stream.ts)
```

## Learning jobs

Turn graded triage into an improved calibration note. A job scans a
project's recent runs, collects the human-recorded actual causes on
`kind: "run"` rows, and writes a new `triage.agent` prompt (see
[Prompts](#prompts)). Drift (`kind: "drift"`) grades use a different label
set and are not read by this job — there is no job that writes
`audit.agent` yet. Jobs are scoped by project/profile and run
asynchronously on the hub, one at a time.

Learning always has Claude write a short prose calibration note from the
graded cases. This needs Claude auth on the hub (`ANTHROPIC_API_KEY` or a
logged-in Claude Code session); without it, the job fails with a clear error
(the hub stays up).

```
POST /api/v1/projects/:project/learning-jobs
  Content-Type: application/json
  body: { profile: string, runLimit?: number }
  → 202 { ...job }   (status "queued"; poll the detail endpoint for progress)

GET /api/v1/projects/:project/learning-jobs?profile=<name>
  → 200 { jobs: [{ id, status, input, createdAt, customPromptVersion, ... }] }
    (newest first; before/after prompt bodies omitted)

GET /api/v1/projects/:project/learning-jobs/:jobId
  → 200 { id, status, input, error, result: { customPromptVersion, beforePrompt,
          afterPrompt } | null, ... } | 404
```

`status` is `queued` → `running` → `succeeded` | `failed`. On success,
`result` carries the fully-rendered analysis prompt before and after the new
custom prompt, for side-by-side review. On failure (no graded cases, no Claude auth
on the hub, or an empty calibration note), `error` explains why.

## Health

```
GET /api/v1/health   (no auth required)
  → 200 { status: "ok", version: 1, queueDepth: <learning jobs waiting> }
```

## CORS

For browser clients on a different origin (an intranet dashboard), start
the hub with `--allow-origin <origin>` (repeatable). Unlisted origins get no
CORS headers and the browser blocks the response.

## TypeScript client

```ts
import { createHubClient } from "ccqa/hub-client";

const hub = createHubClient({ baseUrl: "https://hub.example", token: "<token>" });

// Push a finished report as a run (packDirToTarGz is the same helper
// `ccqa hub push` uses internally, exported from ccqa's own source tree —
// most clients build the gzip archive with any tar library instead).
const archive = await packDirToTarGz("./ccqa-report");
const run = await hub.pushRun(archive, { project: "demo", branch: "main" });

// Fetch a session and every variable (including sensitive ones).
const session = await hub.getSession("demo", "staging", "my-login");
const variables = await hub.listVariables("demo", "staging", { includeValues: true });
```

Full method list:

```ts
pushRun(archive: Uint8Array, meta: { project: string; branch?: string }): Promise<Run>
openRun(meta: { project: string; branch?: string; profile?: string; kind?: "run" | "drift" }): Promise<Run>
patchRun(id, body: PatchRunRequest): Promise<Run>
listRuns(q?: { project?; branch?; status?; limit? }): Promise<Run[]>
getRun(id): Promise<Run>
getReport(id): Promise<unknown>
downloadArtifacts(id): Promise<Uint8Array>

listProjects(): Promise<string[]>

getTriage(id): Promise<RunTriage>
putActualCause(id, { feature, spec }, { cause, note? }): Promise<TriageCase>
deleteActualCause(id, { feature, spec }): Promise<void>
importActualCauses(id, labelsExportJson): Promise<{ imported: number }>

putSession(project, profile, name, storageState): Promise<void>
getSession(project, profile, name): Promise<unknown>
listSessions(project, profile): Promise<{ name, updatedAt }[]>
deleteSession(project, profile, name): Promise<void>

putVariable(project, profile, name, { value, sensitive }): Promise<void>
listVariables(project, profile, opts?: { includeValues? }): Promise<HubVariable[]>
deleteVariable(project, profile, name): Promise<void>

putPrompt(project, profile, name, body): Promise<void>
getPrompt(project, profile, name): Promise<string | null>
listPrompts(project, profile): Promise<HubPromptMeta[]>
deletePrompt(project, profile, name): Promise<void>
```

`createHubClient` uses the global `fetch` only (no Node-specific imports),
so it works unmodified in a browser bundle or a Node script alike.

## Security notes

- Read access is real: any holder of `CCQA_HUB_TOKEN` can read stored
  session contents (`GET .../sessions/:profile/:name`) and every variable
  value (`GET .../variables/:profile?include=values`), not just write them.
  This is required for `ccqa run` to fetch plaintext values at run time — the
  hub trades a "write-only secrets" guarantee for letting a CI job hold
  exactly one secret instead of one per session/variable.
- The hub is a single shared-secret token, not per-client credentials — treat
  it like an admin password. There's no user-level access control.
- Run it behind a reverse proxy with TLS and, for anything beyond a trusted
  LAN, an additional auth layer (SSO, VPN) — the bearer token alone is not
  meant to be internet-facing.
- A token embedded in a `?token=` URL (browser `<img>`/`<a>` tags) can leak
  through browser history or proxy access logs. Keep the hub's audience
  small and rotate `CCQA_HUB_TOKEN` periodically, and immediately if you
  suspect exposure.
- The bundled UI's Secrets tab sends plaintext values over this same API —
  it's a management surface for a trusted, TLS-protected environment, not
  for the open internet. The UI persists the bearer token in the browser's
  localStorage (so it reconnects without re-prompting) and clears it on
  "Disconnect"; it never writes plaintext secret values there. This convenience
  leans on the trusted-network assumption and on the UI never using
  `innerHTML` — keep the hub behind TLS/SSO/VPN accordingly.
