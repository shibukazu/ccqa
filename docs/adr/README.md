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

## Template

Copy [`template.md`](template.md) to start a new record.
