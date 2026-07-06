# 0007. Where a capability lives: the CLI/Hub responsibility split

- Status: accepted
- Date: 2026-07-06

## Context and problem statement

ccqa now has two long-lived surfaces — the `ccqa` CLI (run locally or in CI)
and the hub (`ccqa serve`, a shared HTTP server) — and a growing backlog of
features that could plausibly attach to either: failure-classification
follow-ups (auto-fix a drifted test, propose a spec update, notify on a
product bug), notifications, learning loops. Each time such a feature comes
up, the same question resurfaces: does the CLI do it, or the hub? ADR-0006
settled the biggest case ("the hub aggregates, it never executes"), but that
was framed around *running specs*. We keep re-deriving the boundary for every
new capability. This ADR writes the boundary down once, as a rule that
decides where a new capability — and the data it needs — belongs.

## Considered options

- Decide case by case (status quo). Re-litigates the boundary per feature and
  drifts over time.
- Push everything toward the hub, so the CLI stays a thin client. Contradicts
  ADR-0006 and forces the hub to hold compute/credentials it shouldn't.
- Write down a single ownership rule keyed on two axes — *does it execute /
  have side effects on the consumer's repo or environment?* and *is the data
  source-of-truth or shared state?* — and place every capability by it
  (chosen).

## Decision outcome

Chosen option: "a single ownership rule", because the two surfaces already
have naturally disjoint capabilities and the only real cost has been not
naming the seam.

### The rule, in one sentence each

- **The CLI is the only thing that executes and the only thing that touches
  the consumer's repository or environment.** Running specs, reading/writing
  `test.spec.ts` and `spec.yaml`, invoking `git`/`gh`, opening pull requests,
  driving the browser, calling out to a webhook — anything with a side effect
  outside the hub's own storage happens in a CLI process (a laptop or a CI
  job). This is ADR-0006's "run is the one execution engine", generalised
  from *running* to *every side effect*.
- **The hub is the only shared, durable place for state that outlives one
  run and is read by more than one machine.** Run history, triage
  predictions and human-recorded ground truth, sessions, variables, learned
  prompt overlays, and — going forward — the *review/approval state* of a
  proposed change. The hub records and serves; it never acts.

### Two axes that decide placement

When a new capability appears, place it by answering two questions.

**Axis 1 — does it execute or have an external side effect?**

Running a spec, editing a file in the consumer's checkout, a `git commit`,
`gh pr create`, an HTTP POST to someone's Slack — all yes. These go in the
CLI, because the CLI already runs where the repo, the git credentials, the
`GITHUB_TOKEN`, and the CI billing live. The hub has none of these and
(ADR-0006) deliberately holds no compute budget. **A capability with an
external side effect never lives on the hub.**

**Axis 2 — is the data source-of-truth, or shared/derived state?**

Source-of-truth (specs, `user.md` prompt, the app under test) lives in the
consumer's git repo and is read by the CLI. Shared or derived state (run
reports, triage ground truth, sessions, variables, learned overlays,
approval decisions) lives in the hub, because it must be read across
machines and it changes without a commit. This is the "source in the repo /
state in the hub" split already stated in ADR-0006's follow-up work and the
prompt-learning design — restated here as a general rule.

### The decision table

| Kind of thing | Lives in | Why |
|---|---|---|
| Executing a spec | CLI (`ccqa run`) | ADR-0006: the one execution engine |
| Editing `test.spec.ts` / `spec.yaml` | CLI | touches the consumer's repo checkout |
| `git` / `gh` / opening a PR | CLI | needs repo + git creds + `GITHUB_TOKEN`, already present in CI |
| POST to a notification webhook | CLI (see note) | an external side effect; URL injected as a CI secret |
| Driving the browser | CLI | ADR-0006 |
| Run history / reports | Hub | shared, read across machines |
| Triage prediction + actual cause | Hub | derived state; the accuracy loop reads it (ADR-0006) |
| Sessions / variables | Hub | shared secrets, read by any run (ADR-0006) |
| Learned prompt overlays | Hub | derived state, produced by a hub job |
| **Approval / review state of a proposed change** | **Hub** | shared decision that outlives one run; the *acting* on it is still the CLI |

Note on the webhook: the *act of sending* is an external side effect and so
is CLI-shaped by Axis 1. The *decision to notify* co-locates with that actor
(the CLI already has the classification at the end of a run) — so both the
threshold and the send live CLI-side by default. Only when de-duplication
across N parallel CI runs is required do both move to the hub, under "the one
allowed exception" below.

### The one allowed exception

The hub may acquire *outbound* side effects (e.g. sending a notification) only
under one objective condition: **correctness requires collapsing N parallel
CI runs into a single message** — cross-run de-duplication that a single CLI
process structurally cannot do, because it only sees its own run. A
single-run notification is always CLI. This keeps the exception a test, not a
judgement call: "is this inherently cross-run?" — if no, it is CLI. Such an
exception is opt-in, documented, and still never touches the consumer's repo
or runs a spec — it may only *send*, never *act on code*. Editing files and
opening PRs (and every other `gh` write, e.g. `gh issue create`) stay
CLI-only, always.

### Two recurring patterns the rule implies

- **CLI computes from source → hub persists the artifact.** Read-only Claude
  calls that read the consumer's checkout (generating a spec-update proposal,
  re-running `diagnose()` for a concrete fix) are CLI by Axis 1, but they
  *produce* shared state (a proposal, an accuracy sample) that the hub then
  stores. The computation is CLI; the persistence is hub. Every future
  "analyze-then-record" feature follows this shape.
- **Computation co-locates with the actor, unless it is inherently
  cross-run.** When it is unclear whether a threshold/decision (e.g. "should
  we notify?") belongs to the CLI or the hub, put it next to whatever
  *performs* the resulting action — the CLI, unless the decision needs data
  from more than one run, in which case it (and the send) move to the hub
  under the exception above. This prevents splitting one feature's logic
  across both surfaces.

### How this decides the three classification follow-ups

The failure classifier (`TEST_DRIFT` / `SPEC_CHANGE` / `PRODUCT_BUG`) already
runs inside `ccqa run` and its prediction is aggregated by the hub. The
follow-up *actions* place cleanly by the rule:

- **`TEST_DRIFT` → fix the test.** Editing `test.spec.ts` and opening a PR are
  repo side effects → **CLI**. The classification *gate* (only act when the
  label is `TEST_DRIFT` with high confidence) travels with the prediction the
  CLI already has. The hub's role is to hold the accuracy history that decides
  when auto-apply is allowed to graduate from "suggest only".
- **`SPEC_CHANGE` → propose a spec update.** Generating the proposed
  `spec.yaml` diff is a CLI action (it reads the repo); *accepting* it is a
  shared human decision → the approval state is **Hub** (Chromatic-style
  accept/reject), but the edit that follows an accept is applied by the
  **CLI**. Unapproved proposals never mutate the repo.
- **`PRODUCT_BUG` → notify.** Sending to a webhook is an external side effect
  → **CLI** by default (fired at the end of the run, with the webhook URL as a
  CI secret). A hub-side aggregated sender is the allowed exception above, for
  when duplicate notifications across parallel CI jobs must be collapsed.

Because opening the pull request is the repo-touching step, and the CLI is the
only surface with the repo and git credentials, **the PR-creation path is
CLI-shaped**: a run in CI already has the checkout, the `GITHUB_TOKEN`, and (in
the classification follow-ups) the diff to apply. The hub contributes the
*approval/accuracy state* that gates whether a PR is opened automatically, not
the act of opening it.

### Consequences

- Good: every future capability has a one-question home (Axis 1, then Axis 2);
  the hub stays a thin, credential-light aggregation layer that is easy to run
  anywhere; CI keeps its single secret and its existing git/`gh` powers; the
  PR-automation path lands where the repo already is.
- Bad / cost: a capability that is *conceptually* about the hub's data (e.g.
  "notify on a product bug") may still have to run CLI-side because sending is
  a side effect — the seam is by side effect, not by subject matter, which can
  feel counter-intuitive until the rule is internalised.
- Follow-up: the classification follow-ups (`TEST_DRIFT` auto-fix, `SPEC_CHANGE`
  proposal, `PRODUCT_BUG` notification) are specified per this split in their
  respective issues; the "approval state" store on the hub is new surface to
  design when `SPEC_CHANGE` proposals are built.

### Confirmation

This ADR is a codification of the boundary already realised in the tree:
`ccqa run` is the only executor (ADR-0006); `src/hub-client/` exposes only
data methods (push/get/list, no execute); the CLI is the only caller of `git`
(`src/cli/git-branch.ts`, `src/drift/affected.ts`, `src/report/diff.ts`) and
does not yet call `gh`; the hub API handlers (`src/hub/api/handlers/`) only
record and serve. No code changes accompany this ADR; it constrains future
ones.

## More information (optional)

- ADR-0006 (`0006-hub-results-control-plane.md`) — the execution-side decision
  this generalises.
- `docs/hub.md`, `docs/hub-api.md` — the hub's current surface.
- The classification follow-up issues that apply this split.
