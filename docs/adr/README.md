# Architecture Decision Records

This directory records the *why* behind ccqa's larger architecture decisions, so
a future contributor (human or another Claude Code session) can pick up the
codebase without re-deriving the reasoning from scratch.

We use [MADR](https://adr.github.io/madr/) (Markdown Any Decision Records). Each
record is one Markdown file, one decision, kept short. Records are immutable once
accepted — to change a decision, add a new ADR that supersedes the old one and
flip the old one's status to `superseded by ADR-NNNN`.

## Conventions

- File name: `NNNN-imperative-title.md` (zero-padded number, lowercase, dashes).
- Status: `proposed` → `accepted` → optionally `deprecated` / `superseded`.
- Keep it to roughly a page. Capture the decision and the trade-offs, not a full
  design doc.
- Treat ADRs like code: they go through the same PR review as the change they
  describe.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-lenient-post-trace-validation.md) | Post-trace validation defaults to lenient (warn, don't drop) | accepted |
| [0002](0002-avoid-agent-browser-wait-selector.md) | Never use `agent-browser wait <css-selector>`; poll `get count` instead | accepted |
| [0003](0003-perspectives-factual-inventory.md) | `perspectives` is a factual coverage inventory, not a decision record | accepted |
| [0004](0004-unify-run-commands.md) | Per-spec mode dispatcher: `run` reads `mode:`, `record` collapses `trace + generate` | accepted |
| [0005](0005-session-restore-model.md) | Restore browser sessions by name, not by spec-embedded path | accepted |
| [0006](0006-hub-results-control-plane.md) | Hub is a results/sessions/variables control plane, not a remote executor | accepted |
| [0007](0007-cli-hub-responsibility-split.md) | Where a capability lives: the CLI executes and touches the repo, the hub holds shared state | accepted |
| [0008](0008-classification-and-action-are-orthogonal.md) | Classification and action are orthogonal: `run` classifies, `act` responds, the workflow maps label→action | accepted (label set amended by 0016) |
| [0009](0009-incremental-run-push.md) | A run is mutable while running, immutable once terminal | accepted |
| [0010](0010-rerun-selection-from-a-deploy-log.md) | "Needs re-run" is decided from a deploy log the hub is told about, never from a guessed ref | accepted (amended by 0011, state model superseded by 0014) |
| [0011](0011-replace-relatedpaths-with-model-selection.md) | Replace `relatedPaths` glob matching with `ccqa select-specs` model selection | superseded by ADR-0024 |
| [0012](0012-flag-names-carry-their-group.md) | Flag names carry their group, and one flag means one thing | accepted |
| [0013](0013-one-verification-environment.md) | One verification environment; a profile is a value set, not an environment | accepted |
| [0014](0014-two-axes-one-verdict.md) | Two axes, one verdict; work in flight is a claim, not a state | accepted (execution axis amended by 0020) |
| [0015](0015-serial-groups-in-one-place.md) | Serial groups live in one place: `.ccqa/config.yaml`, not each spec | accepted |
| [0016](0016-one-vocabulary-two-answerable-subsets.md) | One vocabulary, two answerable subsets: the run answers all four causes, the audit only two | accepted |
| [0017](0017-records-the-hub-does-not-judge.md) | Records the hub stores but does not judge: a run kind that advances no ledger, and an opaque key set | accepted |
| [0018](0018-the-bump-answers-the-hub.md) | The bump answers the hub, and the diff checks the answer | accepted |
| [0019](0019-what-a-person-may-overrule.md) | A person may overrule a judgement, never a result | accepted (lapse behaviour settled by 0020) |
| [0020](0020-a-lapsed-attestation-hands-the-spec-back.md) | A lapsed attestation hands the spec back to the cycle | accepted |
| [0021](0021-what-a-spec-actually-reached.md) | Measure what a spec reached, per spec, in a shared environment | accepted (transport amended by 0022) |
| [0022](0022-coverage-flows-through-an-inbox.md) | Coverage flows through an inbox; interpretation is one resolver | accepted |
| [0023](0023-an-undecided-selection-is-not-a-reach.md) | An undecided selection is not a reach | accepted |
| [0024](0024-selection-from-measured-reach.md) | Spec selection reads measured reach, not a model's guess | accepted (staleness amended by 0026) |
| [0025](0025-source-maps-for-a-deployed-commit.md) | Source maps for a deployed commit live on the hub | accepted |
| [0026](0026-measured-edges-are-a-ledger.md) | Measured edges are a ledger, and an unmeasured spec runs | accepted |

## Template

Copy [`template.md`](template.md) to start a new record.
