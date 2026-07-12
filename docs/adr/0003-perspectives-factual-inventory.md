# 0003. `perspectives` is a factual coverage inventory, not a decision record

- Status: accepted (amended 2026-07-13 — see Amendment below)
- Date: 2026-05-25

## Context and problem statement

Teams running ccqa still keep a hand-maintained QA spreadsheet (use case,
steps, expected result, **severity**, automation status). We want ccqa to
surface "what is tested today" so that spreadsheet has a living, code-adjacent
counterpart. The open question was *how much* of the spreadsheet ccqa should
own. Two parts pull in opposite directions: the **coverage stock-take** (which
test cases exist, what each verifies) is mechanical and benefits from being
regenerated; the **severity / priority** column ("how badly does the customer
hurt if this breaks") is a judgement the team and PdM negotiate, and an AI that
silently rewrites it erodes the shared agreement it represents.

## Considered options

- **Mirror the whole spreadsheet** — include severity, priority, and a
  code-vs-test gap analysis (untested areas) in the generated file.
- **Factual inventory only** — generate a per-feature list of existing specs
  with an AI-written `summary` of what each verifies; carry no severity and do
  no gap analysis. A human-only `note` field is preserved across regeneration.
- **Read-only, human-authored file** — ccqa never writes perspectives; humans
  maintain it by hand.

## Decision outcome

Chosen option: "factual inventory only", because the stock-take is the part
that rots without automation, while severity is a human decision ccqa should
not author or overwrite. A flat dump of untested areas (gap analysis) was
explicitly rejected as noise: without prioritisation it gets ignored, and
prioritisation is exactly the human judgement we are keeping out of scope.

Concretely: `.ccqa/perspectives.yaml` holds `features[].specs[]` with
`title`/`relatedPaths` transcribed from each spec.yaml, a mechanically-derived
`status` (`traced`/`generated` from on-disk artifacts), AI-authored descriptive
fields (`summary`, plus the QA-table-style `startScreen` / `testCondition` /
`preconditions`), and an optional human `note`. The top-level schema is
`.strict()`, so a stray `severity:` key is rejected at parse time — the boundary
is enforced by the type, not just convention.

The detailed test procedure and per-step expected results are deliberately NOT
carried here: the spec.yaml steps are the single source of truth, and
duplicating them would create a second copy to drift out of sync. The inventory
links back to the spec instead.

Output is **one canonical YAML plus a tree of Markdown views**.
`.ccqa/perspectives.yaml` is the single machine-readable source of truth and
holds every field for every case (including the human `note`). The Markdown is
regenerated from it on apply and split so that `.ccqa/` itself stays meta:

- `.ccqa/perspectives.md` is a thin **category index** — per feature, a heading
  linking to that category's detail file, then one row per case (title + a link
  to its spec.yaml). No per-case detail here.
- `.ccqa/features/<category>/perspectives.md` carries the detail for one
  category: each case as a self-contained vertical (item | content) table,
  ordered 検証内容 → 前提条件 → 開始画面 → spec → 関連コード → note. The spec
  is a **relative Markdown link** so it resolves both on GitHub and in a local
  editor; related-code paths stay inline code (their base — the cwd hosting
  `.ccqa/` — is not reliably recoverable here, since specs mix cwd-relative and
  repo-root path forms, and many are globs). Nothing is emitted outside the
  table, and the steps are still never restated — the table links back to each
  spec.

The diff shown on apply is the YAML; all Markdown is regenerated from it. YAML
was kept as the canonical form because it diffs cleanly and parses
unambiguously; the per-category Markdown split was chosen because a single flat
document of many specs is hard to scan, and keeping the root `.ccqa/` view to a
category index makes "what is tested, and where" answerable at a glance while
the detail lives next to each category's test cases.

### Consequences

- Good: the inventory regenerates deterministically; the structure (which
  specs exist, their status) is decided by the CLI, so Claude can only fill
  `summary` and cannot invent or drop entries.
- Good: human intent survives. `note` is preserved across regeneration, giving
  the team a place to record decisions (including a pointer to wherever
  severity actually lives) without ccqa clobbering it.
- Bad / cost: severity and gap analysis — arguably the highest-value parts of a
  QA table — are deliberately out of scope, so perspectives does not replace
  the spreadsheet on its own yet. Those are left to a later, prioritisation-
  aware feature.
- Follow-up: a custom-prompt, priority-aware gap analysis (and an Explorer-style
  enumeration) were discussed and parked; revisit once the inventory is in use.

### Confirmation

`ccqa perspectives` was run end-to-end against a real `.ccqa/` with 11 specs
across 4 features: the generated `perspectives.yaml` carried no severity field,
`status` matched the on-disk `actions.json` / `test.spec.ts`, and the
`summary` / `startScreen` / `testCondition` / `preconditions` reflected each
spec's steps. The root `perspectives.md` rendered a category index (heading +
one row per case linking to its spec.yaml), and each
`features/<category>/perspectives.md` rendered one vertical table per case —
検証内容 first, with a relative link to spec.yaml (related-code paths as inline
code) — without restating the steps. The spec link was verified to resolve to
the real file from the category file's location. A hand-added `note` survived a
regeneration that rewrote the sibling `summary` and re-rendered as a `📝 note`
table row.
Unit tests cover the schema boundary (a `severity`-like key is rejected), the
note-preservation merge, the QA-table field parsing/merge, and the Markdown
rendering (including that it does not restate steps/expected results).

## Amendment (2026-07-13): the inventory is hub-only; the repo carries no copy

The original output layout — `.ccqa/perspectives.yaml` plus a tree of
Markdown views — put a generated document into the consuming repo that
nothing else read. Once the hub became the shared store for everything
cross-cutting (runs, secrets, prompts), keeping a second, repo-committed copy
of the inventory was pure noise: it churned diffs on every regeneration and
could silently drift from what teammates saw.

What changes (the *storage and freshness* of the inventory, not its scope):

- The document is stored **on the hub only**, one JSON document per project
  (`PUT/GET /api/v1/projects/:project/perspectives`). No `.yaml`/`.md` files
  are written to the repo; `ccqa perspectives` deletes leftovers from older
  versions when it runs, and it now requires a hub connection.
- The Markdown views are replaced by the hub UI's **Perspectives** view
  (summary strip, one feature-grouped table, expandable per-case detail).
- The document stays fresh incrementally: a successful `ccqa record` /
  `ccqa generate` upserts that one spec's entry (mechanical facts recomputed,
  descriptive fields rewritten by a single-spec Claude call, `note`
  preserved). The full command remains the way to build the document
  initially and to prune deleted specs.
- `note` — still the only human-authored field — is edited in the hub UI
  (`PATCH .../perspectives`, a serialized read-modify-write), since there is
  no local file left to hand-edit.

The factual-inventory boundary (no severity, no gap analysis, `.strict()`
schema) is unchanged.

## More information

- Schema: `src/spec/perspectives-schema.ts`
- Command: `src/cli/perspectives.ts`, prompt: `src/prompts/perspectives.ts`,
  incremental sync: `src/cli/perspectives-sync.ts`
- Hub endpoints: `src/hub/api/handlers/perspectives.ts`
  (see `docs/hub-api.md#perspectives`)
- Related: ADR-0001 (lenient over strict — preserve human-load-bearing data
  rather than silently dropping it; the `note` preservation here follows the
  same instinct). ADR-0007 (hub/CLI responsibility split — the hub as the
  shared store, the CLI as the executor).
