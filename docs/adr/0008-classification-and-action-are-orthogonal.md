# 0008. Classification and action are orthogonal

- Status: accepted
- Date: 2026-07-07

## Context and problem statement

ADR-0007 placed the three failure-classification follow-ups (auto-fix a
drifted test, propose a spec update, notify on a product bug) and, in doing
so, wrote them as a fixed 1:1 mapping — `TEST_DRIFT → fix`,
`SPEC_CHANGE → propose`, `PRODUCT_BUG → notify`. Real pipelines don't split
that cleanly: one team wants to be *notified* about `TEST_DRIFT` too, another
wants to *propose* a spec change off a `PRODUCT_BUG`, a fork's CI wants only
notifications and never an auto-PR. Baking the label→action choice into the
tool forces every consumer into one policy and makes "let me also do X on
label Y" a code change. We need the classification and the response to it to
be two independent axes the user composes, not a hard-wired pair.

## Considered options

- Keep the 1:1 label→action binding from ADR-0007. Simple, but every consumer
  gets one policy and can't recombine.
- Make each action configurable with a label→action table stored in a repo
  file (`.ccqa/…`). Recombinable, but it puts a *deployment/policy* decision
  in the source tree, and splits the choice across the repo and the workflow
  (contradicts ADR-0007's "computation co-locates with the actor").
- Decouple the two axes entirely: `ccqa run` classifies; a separate `ccqa act`
  command family responds; the label→action mapping is expressed in the CI
  workflow (which action job runs over which label). (chosen)

## Decision outcome

Chosen option: "decouple the two axes", because the label→action mapping is a
per-environment policy, not a property of the spec, so it belongs where the
pipeline is assembled — the workflow — and the response logic belongs in
reusable commands that don't care which label produced a failure.

This is a refinement of how ADR-0007 is *applied*, not a reversal of it: every
action is still a side effect and so is CLI-shaped (ADR-0007 Axis 1); the
classification and the proposal-approval state are still shared and so live on
the hub (ADR-0007 Axis 2). ADR-0008 only retires the fixed pairing.

### Two axes

- **Axis A — classify.** `ccqa run` labels each failed spec
  `TEST_DRIFT | SPEC_CHANGE | PRODUCT_BUG | UNKNOWN` and writes it into
  `report.json` (already there: `FailureAnalysis.label` per
  `ReportSpecResult`). Unchanged by this ADR.
- **Axis B — act.** A new `ccqa act <verb>` family (`fix`, `propose`,
  `notify`, and future verbs) takes classified failures as *input* and
  produces a side effect. An action does **not** hard-code a label. It is
  handed a set of targets and, per target, decides only *can I actually do
  this here* (capability), never *should this label be handled* (policy).

Policy — which labels an action runs over — is the user's, expressed with a
repeatable `--label` filter. Absence of `--label` means "all failed specs".
So `ccqa act notify --label PRODUCT_BUG` and `ccqa act fix --label PRODUCT_BUG`
are both legal; the second simply skips targets it can't deterministically
repair. "Any action can, in principle, run on any label" is literally true.

### The common action shape

Every verb is the same skeleton over the same inputs:

```
resolve report  →  filter by --label  →  for each target:
    applicability(target) ?  act  :  skip(reason)
  →  collect outcomes  →  print summary  →  exit 0 unless --fail-on-error
```

- **Input** is a projection of the failed `ReportSpecResult`s
  (`feature`, `spec`, `label`, `confidence`, `subDiagnosis`, `specYaml`,
  `diffExcerpt`, `failureLogExcerpt`, `evidence`) — exactly what `report.json`
  already carries, so routing needs no schema change.
- **Output** is a per-target outcome: `applied` / `skipped(reason)` /
  `failed(error)` plus a human summary.
- **Non-applicable combinations skip, they don't error.** `fix` on a live
  spec skips ("no deterministic `test.spec.ts` to repair"); `fix` on a
  `PRODUCT_BUG` attempts a diagnosis, finds no validated repair, and skips.
  An action exits non-zero only on an infrastructure error (unreadable
  report, hub unreachable, webhook 5xx under `--fail-on-error`) — never
  because a target wasn't applicable. This keeps a fix-then-notify pipeline
  from failing the build just because fix had nothing to do.

### Passing the classification from run to act (per ADR-0007)

The report is a run artifact (CLI-produced); the hub is its shared copy. Every
`act` verb accepts both, `--report` primary and `--run-id` optional:

- `--report <dir>` — read `report.json` from the local run artifact. The
  same-job / same-artifact path; the default; zero hub dependency.
- `--run-id <id>` — fetch the report from the hub (`hub.getReport`) for the
  cross-job / cross-machine case, plus `downloadArtifacts` when evidence files
  are needed.

The report is the **routing** channel only. Each action re-computes its own
payload from the checkout — the "CLI computes from source" pattern ADR-0007
names. In particular `fix` does **not** trust line numbers baked at run time:
`report.json` carries `subDiagnosis` (a label) but not the concrete
`Diagnosis` (line / old-selector / new-selector), and those are only valid
against the exact `test.spec.ts` bytes that ran. So `fix` re-derives in the
act-time checkout (`diagnose()` → `applyDiagnosis` → re-run vitest to prove the
edit) — more correct than replaying a stale payload, and it keeps `report.json`
a classification+evidence artifact (ADR-0006). Consequently `act fix` costs a
diagnose+replay per target; it is not a free "apply the report" step.

### The three verbs

- **`fix`** — deterministic code repair. Re-derive and apply via
  `applyDiagnosis`, then re-run the spec and keep the edit only if it now
  passes. Deterministic specs only; live specs and unrepairable failures skip.
  Opening the PR is a repo side effect → CLI (ADR-0007).
- **`propose`** — draft a `spec.yaml` update and record it for approval.
  Drafting reads the checkout (CLI); the **approval state is the new hub
  surface** ADR-0007 earmarked ("approval/review state of a proposed change →
  Hub"). `propose` stores a `pending` proposal on the hub; a human accepts /
  rejects in the hub UI; applying an accepted proposal writes `spec.yaml`
  (`saveSpecFile`) — always CLI. `fix` and `propose` stay separate verbs:
  `fix` self-validates and is safe to auto-apply; `propose` changes *what is
  verified*, a human judgement that needs the approval gate.
- **`notify`** — generic webhook POST. Body is a neutral JSON summary built
  from `report.json`; `--webhook-url` is injected as a CI secret. Single-run
  send is CLI (ADR-0007 default); cross-run de-duplication is ADR-0007's one
  hub exception and is out of scope here.

### Command surface

```
ccqa act fix     --report <dir> | --run-id <id>
                 [--label <LABEL> ...] [--min-confidence <0..1>]
                 [--dry-run] [--fail-on-error] [--model <m>] [--cwd <path>]
ccqa act propose --report <dir> | --run-id <id> [--label <LABEL> ...]
                 [--project] [--hub-url] [--hub-token] [--apply-approved]
                 [--dry-run]
ccqa act notify  --report <dir> | --run-id <id> [--label <LABEL> ...]
                 --webhook-url <url> [--fail-on-error] [--dry-run]
```

`--report` and `--run-id` are mutually exclusive; neither given defaults to
the local report dir. Shared flags are factored like the option tuples in
`src/cli/hub.ts`.

### The GitHub Actions shape

The mapping *is* the workflow: a `classify` job runs `ccqa run` and uploads
`report.json` as an artifact; independent `act` jobs (`needs: classify`) each
download it and run one verb over one `--label`. A team omits any job or
repoints its `--label` freely — that is the label→action policy, expressed
where the pipeline is assembled, not in the tool.

### Consequences

- Good: any consumer composes its own label→action policy in its workflow with
  no code change; "3 labels, 3 actions, any combination" holds; each action is
  a small reusable command; ADR-0007's placements (edits/PRs = CLI, approval =
  hub, notify = CLI) carry over intact.
- Bad / cost: `act fix` re-runs Claude + vitest per target, so it is heavier
  than applying a static report — gate it with `--label` and
  `--min-confidence`. The proposal-approval hub surface is net-new (no
  `proposal` exists in the tree today) and is the largest new build. If a
  pipeline runs `act` against a different commit than `run`, the checkout must
  match the classified commit — a documented precondition the tool can't
  enforce.
- Follow-up: ADR-0007's "How this decides the three classification
  follow-ups" section is superseded in part by this ADR (the 1:1 binding is
  retired; its per-surface placements stand). The `hub` proposal/approval
  endpoints and the `ccqa act` family are specified in their respective
  issues.

### Confirmation

No code accompanies this ADR; it constrains the follow-up work. The design is
consistent with the tree as read today: `FailureAnalysis.label` is already per
failed spec in `report.json`; `applyDiagnosis` / `diagnose()` /
`saveSpecFile` / `getTestScript` / `getTraceActions` exist as the primitives
the verbs compose; `hub.getReport` / `downloadArtifacts` exist as the
`--run-id` path; no `proposal` surface exists yet (the one net-new piece).

## More information (optional)

- ADR-0007 (`0007-cli-hub-responsibility-split.md`) — the two-axis rule this
  reuses; its 1:1 follow-up binding is what this ADR retires.
- ADR-0006 (`0006-hub-results-control-plane.md`) — report.json as the run's
  immutable result; the hub aggregates, it never executes.
- The `ccqa act` and hub-proposal issues that implement this split.
