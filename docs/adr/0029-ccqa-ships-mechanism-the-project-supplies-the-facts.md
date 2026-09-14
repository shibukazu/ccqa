# 0029. ccqa ships mechanism; the project supplies the facts

- Status: accepted
- Date: 2026-09-11

## Context and problem statement

Two features land together: `kind: external` targets, where a project
defines a target entirely in `.ccqa/config.yaml` with no plugin code of its
own, and a markdown intent source, where a project keeps writing test cases
as markdown, in its own headings, and ccqa reads them. Both exist for the
same reason — a real project already has a test framework and a way its
team writes test cases, and neither looks like what ccqa ships.

The two features share one question: where does the knowledge of *this*
project's shape live? The framework's file conventions, the headings a team
already writes cases under, the mapping from a priority value to a title
tag, the URL of a team's own tracking sheet. Put it in ccqa's source and
every new consumer needs a ccqa change, or a fork, to fit their own repo.
Leave it nowhere and the two features cannot work at all — something has to
say which heading means "steps" and where the compiled test file goes.

## Considered options

- **Grow ccqa's source per consumer.** A conditional, an adapter, a special
  case per downstream repo's conventions. Each one is dead weight for every
  other consumer, and ccqa's source becomes a map of who currently uses it.
- **A generic mechanism, configured entirely outside ccqa's source.** ccqa
  ships the shape — an intent source it can read, a path template, write
  roots, header/tag templates — and reads every specific fact from
  `.ccqa/config.yaml` and the project's own files.
- **Require the consumer to pre-transform their data.** Ask every project to
  translate its markdown into `spec.yaml` and its framework into one ccqa
  already ships. This is the same "adapt to ccqa" cost the feature exists to
  remove, not a way to avoid it.

## Decision outcome

Chosen option: **a generic mechanism, configured outside ccqa's source.**
`kind: external` names a target with no plugin code — only `framework`,
`testPath`, `writeRoots`, `resources`, `conventions`, `runCommand`,
`checkCommands`, `runId`, `hooks`, `header`, and `titleTags` in config.
`intent: { kind: markdown, root, fields }` reads a project's own markdown,
with `fields` mapping ccqa's nine-word vocabulary (title, precondition,
steps, expected, cleanup, priority, link, outputPath, result) onto whatever
headings the project already writes. A heading the map does not name is
passed through as context, unparsed — ccqa does not need to understand it
to carry it.

The line is drawn at what ccqa can name generically versus what only one
project knows. A path template, a write-root list, a tag format string —
these are shapes every consumer needs, worded the same way regardless of
which repo it is. A heading called "Given" instead of "Precondition", a
page-object convention, a login helper, the URL of a team's own tracking
sheet — these are true of exactly one project, and ccqa's source is the
wrong place to write down a fact that holds for one repo.

Consequences:

- **ccqa stays product-agnostic.** Nothing under `src/` grows a name, a URL,
  or a heading that belongs to a downstream project — the config file and
  the project's own markdown carry all of it.
- **A second consumer needs no ccqa change.** Fitting a new repo's framework
  and vocabulary is a config file and a field map, not a pull request
  against this tool.
- **Config gets bigger.** A project on an external target with a markdown
  intent source writes more YAML than one on a built-in target with
  `spec.yaml` — the facts ccqa no longer hard-codes have to be written
  somewhere, and that somewhere is now visibly the consumer's.
- **A mis-mapped heading is a config error, not a code error.** `fields:
  steps: Test steps` pointing at a heading the file does not have fails the
  same way a missing numbered list does — at the one case, with a message
  naming the heading — never as a ccqa bug report.
- **The vocabulary itself is closed.** `title` / `precondition` / `steps` /
  `expected` / `cleanup` / `priority` / `link` / `outputPath` / `result` is
  what ccqa can act on; a project's tenth concept has nowhere to map to and
  stays passed through as context, never acted on.
