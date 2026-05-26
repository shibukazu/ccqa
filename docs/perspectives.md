# Perspectives

`ccqa perspectives` inventories the test coverage that already exists under `.ccqa/` into `.ccqa/perspectives.yaml` — the ccqa equivalent of a hand-kept QA spreadsheet, scoped deliberately to *facts about what is tested today*. It writes:

- **`.ccqa/perspectives.yaml`** — the machine-readable source of truth. Holds every field for every case (including the human `note`); the Markdown views are regenerated from it.
- **`.ccqa/perspectives.md`** — a thin **category index**: per category, a heading linking to that category's detail file, followed by one row per case (case title + a link to its `spec.yaml`). Meta only — no per-case detail lives here.
- **`.ccqa/features/<category>/perspectives.md`** — one file per category, carrying the full per-case detail. Each case is a self-contained vertical table whose rows are 検証内容 (verification summary) → 前提条件 (preconditions) → 開始画面 (start screen) → spec → 関連コード (related code) → note. The spec is a **relative Markdown link** (resolvable on GitHub and in a local editor); related-code paths stay inline code, since their base isn't reliably recoverable and many are globs. Nothing is emitted outside the table.

The diff shown on apply is always the YAML (the source of truth); all Markdown files are regenerated from it.

```bash
ccqa perspectives                          # inventory every spec under .ccqa/features/
ccqa perspectives --instruction "..."      # steer how summaries are written
ccqa perspectives --apply                  # skip the [y/N] confirmation
ccqa perspectives --language ja            # write human-readable fields in Japanese
ccqa perspectives --language en            # English fields AND English Markdown labels
```

`--language` directs both the AI-written field values and the Markdown chrome (headings, table headers, row names like 検証内容 / Verifies). An explicit `en` tag switches the labels to English; `auto` (default) and `ja` keep Japanese. Case titles are transcribed verbatim from each `spec.yaml`, so a Japanese-titled spec keeps its title even under `en`.

## What it is — and what it is deliberately not

Perspectives is a **factual stock-take**, not a planning tool. Two things are intentionally kept out of the schema (and `.strict()` rejects them if they appear):

- **No severity / importance / priority.** "How badly does it hurt the customer if this breaks" is a human + PdM decision, not something ccqa should author or silently overwrite. Severity lives wherever your team already tracks it.
- **No code-vs-test gap analysis.** A flat dump of "things in code with no test" is noise without prioritisation; that is a separate, later concern.

## How a case is assembled

Each test case entry is built from three sources, kept strictly separate so facts never drift:

| Field | Source | Notes |
|---|---|---|
| `title` | transcribed from `spec.yaml` | verbatim |
| `relatedPaths` | transcribed from `spec.yaml` | verbatim (see [Drift](./drift.md)) |
| `status` | **mechanically derived by the CLI** | `traced` = `actions.json` exists; `generated` = `test.spec.ts` exists. Never written by Claude. |
| `summary` | Claude, from the spec's steps | 1–2 sentences on *what the spec verifies* |
| `startScreen` | Claude, from the spec's steps | the opening screen; optional |
| `testCondition` | Claude, from the spec's steps | the state the test assumes; optional |
| `preconditions` | Claude, from the spec's steps | setup prerequisites — e.g. which role logs in, derived from `include: login` params and the opening steps; optional |
| `note` | **human-only** | preserved across regeneration |

Claude writes only the descriptive fields and is given read-only `Read` / `Grep` / `Glob` tools. Everything mechanical (`status`) and everything transcribed (`title`, `relatedPaths`) is computed by the CLI, so regenerating never lets an AI rewrite a fact.

### `note` is yours and survives regeneration

`note` is the one field ccqa never authors. When you re-run `ccqa perspectives`, the CLI parses the existing `perspectives.yaml`, carries every non-empty `note` forward by `(featureName, specName)`, and recomputes everything else. Note preservation is best-effort: an unparsable existing file simply yields no carried notes rather than blocking regeneration.

## Example output

`perspectives.yaml`:

```yaml
generatedAt: 2026-05-26T05:32:58.106Z
features:
  - featureName: tasks
    specs:
      - specName: create-and-complete
        title: Create a task and mark it complete
        summary: Verifies a task can be created from the dashboard and transitions to the completed state.
        startScreen: /dashboard
        testCondition: Logged in as a member
        preconditions:
          - A member account is logged in
        relatedPaths:
          - src/features/tasks/**
        status:
          traced: true
          generated: true
        note: Flaky on slow CI — see #123.
```

The root `perspectives.md` lists this under a `## [tasks](tasks/perspectives.md)` heading as a row `Create a task and mark it complete | [spec](features/tasks/test-cases/create-and-complete/spec.yaml)`. The detail lands in `.ccqa/features/tasks/perspectives.md`, where the case is a vertical table (検証内容 → 前提条件 → 開始画面 → spec → 関連コード → note); the spec is a relative link back into the repo and related-code paths are inline code. The detailed steps and expected results are never restated — the spec is their single home.

## Design rationale

See [ADR-0003](./adr/0003-perspectives-factual-inventory.md) for the full reasoning behind the factual-inventory scope and the severity / gap-analysis exclusions.
