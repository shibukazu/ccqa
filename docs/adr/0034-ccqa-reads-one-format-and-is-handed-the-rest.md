# 0034. ccqa reads one format and is handed the rest

- Status: accepted
- Date: 2026-09-20

Supersedes the `intent:` half of
[ADR-0029](0029-ccqa-ships-mechanism-the-project-supplies-the-facts.md) and
amends "The intent is whichever document the project writes" in
[ADR-0030](0030-the-audit-reads-the-product.md).

## Context and problem statement

ADR-0029 let a target declare `intent: { kind: markdown, root, fields }`, and
ccqa grew a markdown reader: section splitting, numbered-list parsing, bullet
parsing, a labelled-link convention, a heading-name map. `fields` was meant
to keep the vocabulary out — the keys are ccqa's, the values the project's —
and for headings it did.

Punctuation is not a heading. Within days of shipping, the reader had begun
learning punctuation from the writing conventions of the documents it was
pointed at: a locale-specific period in its numbered-list pattern, a
locale-specific bullet character in its bullet pattern, a locale-specific
colon in its label pattern.
Each was a two-character diff and each was correct where it came from. None of
them belong in a general-purpose tool: ccqa is published on npm and read by
people who have never seen those documents, and nothing in the repository can
tell a reviewer whether the next such change is a rule of the format or a
habit of one team's prose. A mapping table cannot hold this line, because the
line is not where the table is.

The same reader also decided things the contract never asked it to: which
spellings of `mode` mean "not live", and whether an unrecognised one deserves a
warning. And `intent.fields.outputPath` had ccqa writing back into a file it
does not own — the only place ccqa edits a consumer's source.

Meanwhile every feature had to agree on what a case is anyway: the recorder,
the emitters, the evidence table, the audit, selection and the inventory all
consume one shape. That shape, not the document, is the real interface.

## Considered options

- **Keep the markdown reader and police it in review.** Costs nothing today.
  It asks every reviewer to distinguish a format's rule from a project's habit
  in a two-character diff, which is the judgement that already failed.
- **Keep the reader but freeze it.** Refuses the next accommodation, and with
  it the next legitimate fix; the project that needs one forks or patches.
- **A declarative grammar in config.** Moves the vocabulary out of the source
  but invents a second language, which is a format ccqa now owns — and the
  first case it cannot express brings the accommodations back.
- **A reader module the project owns.** ccqa publishes what a case is and
  imports a module that answers it. Costs a public contract and a loading
  mechanism, and gives up the ability to read any format ourselves.

## Decision outcome

Chosen option: "A reader module the project owns".

ccqa defines what a test case is — an id, a title, a mode, steps, cleanup,
expectations, the document that states it — and ships one reader for its own
`spec.yaml`. Every other format is read by a module the consuming project owns
and points `targets.<id>.cases` at; ccqa imports it, validates what it returns
against the published `Case` shape, and never learns a heading, a bullet
character or a punctuation mark from any project's vocabulary. Every feature —
generate, record, run, audit, select, evidence, perspectives — reaches a case
through one reader, so a format-specific accommodation has nowhere in ccqa to
land.

### Consequences

- The contract is public API: `ccqa/case-source` exports the `Case` shape, its
  zod schema and the factory signature. Changing it is a breaking change, so it
  is kept small — two methods and one plain object.
- A reader is plain JavaScript (`.mjs`/`.js`/`.cjs`). ccqa imports it with no
  loader, because a TypeScript reader would work on some Node versions and not
  others, and "sometimes" is the worst contract to ship. `// @ts-check` plus a
  JSDoc `@type` type-checks it in the consumer's own `tsc` run.
- ccqa no longer writes to a case document. `outputPath` is gone with the rest
  of `intent`; a project that wants the generated path recorded in its own
  files derives it from the case id and its `testPath`.
- `mode` is two values. A source that reads "manual" or "wip" out of its own
  documents decides for itself what that means, which is the only place that
  decision was ever sound.
- ccqa can no longer read a new format by itself, so adopting a second one
  costs the adopter a reader. That is the trade: it is also what stops the
  first adopter's punctuation from becoming everyone's.
- No reference markdown reader ships, in the runtime or beside it. A worked
  example lives in `docs/targets.md` and in the end-to-end fixtures, where it
  cannot accrete behaviour or acquire tests that protect it.
