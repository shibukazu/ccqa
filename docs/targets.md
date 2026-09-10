# Generation targets

A spec's `target:` field picks which plugin turns it into runnable test
code. Omit it and ccqa uses `defaultTarget` from `.ccqa/config.yaml`,
falling back to `agent-browser` when there is no config file at all — a
project that never mentions targets keeps working unchanged.

```yaml
title: Create a task and mark it complete
target: playwright   # omit for agent-browser (the default)
steps:
  - instruction: ...
    expected: ...
```

## The built-in targets

| Target | Input | What `record` / `generate` produce | How `ccqa run` executes it |
|---|---|---|---|
| `agent-browser` (default) | recording | ccqa mechanically compiles the recording into `test.spec.ts` (vitest) | vitest replay (`mode: deterministic`) or Claude live per step (`mode: live`) |
| `playwright` | recording | The same recording, mechanically compiled into a plain `@playwright/test` spec; when the target's `resources` are configured, an LLM pass then rewrites the draft to reuse your existing page objects/helpers | via the target's configured `runCommand` |
| `runn` | spec | No recording step — `ccqa generate` asks Claude to write a [runn](https://github.com/k1LoW/runn) runbook (YAML, validated to parse) directly from the spec, reading the backend sources with Read/Grep/Glob | via the target's configured `runCommand` |

`mode:` and `session:` are agent-browser-only fields; setting them on a spec
whose `target:` resolves to anything else is a validation error.

## `record` vs `generate`

Recording-backed targets (`agent-browser`, `playwright`) need `ccqa record`
once: Claude drives the browser to discover the route, and the actions are
traced into `ir.json` — a tool-neutral intermediate representation shared by
every recording-backed target — which is then handed to the target's
generate step. Spec-input targets (`runn`) have no recording step; `ccqa
generate` is where generation starts.

```bash
ccqa record tasks/create-and-complete     # recording targets: trace + generate
ccqa generate api/create-task             # spec-input targets: generate only
ccqa generate tasks/create-and-complete   # recording targets: re-run generate
                                          # from the saved ir.json
```

- Running `ccqa record` on a spec-input target exits 2 with a pointer to
  `ccqa generate`. Running `ccqa generate` on a recording target with no
  `ir.json` errors with "Run `ccqa record` first".
- Both commands share the codegen flags: `--auto-fix
  <interactive|auto|skip>` (default `interactive`) and `--auto-fix-max-retries
  <n>` (default 3) — see [Auto-fix](./auto-fix.md) — plus `-m/--model`,
  `--language`, `--cwd`, `--hub-profile`, and the hub connection flags.
- To regenerate from an existing `ir.json` without re-recording, run `ccqa
  generate` — `ccqa record` always traces. `--overwrite` replaces an existing
  test without prompting and `--no-replay` skips the route check, see
  [Regenerating from a saved route](#regenerating-from-a-saved-route).
- `ccqa record` also accepts `--trace-only` (stop after the trace),
  `--trace-validation <lenient|strict>`, and `--learn-hub-trace-prompt` (refresh
  the hub-stored `record.agent` learning notes after the trace).

> **Breaking change:** recordings used to be stored as `actions.json`; they
> are now `ir.json`. There is no migration — re-run `ccqa record` for any
> spec recorded before the change.

## `.ccqa/config.yaml`

Targets are configured project-wide. The file is validated strictly — an
unknown key or an unregistered target name is an error.

```yaml
defaultTarget: playwright   # used when a spec has no target: (default: agent-browser)

targets:
  playwright:
    # where this target's generated test lands; omit for the spec's own directory
    testPath: e2e/specs/{feature}/{spec}.spec.ts
    # optional; enables `ccqa run`. {artifactsDir} collects traces into the report.
    runCommand: "pnpm exec playwright test --trace retain-on-failure --output {artifactsDir} {files}"

    # Existing code the generated test should import instead of duplicating.
    resources:
      - path: e2e/pages
        description: page objects, one per screen
      - path: e2e/steps
        description: shared multi-screen helpers (e.g. login)
      - package: "@your-org/e2e-kit"
        description: shared fixtures and selectors published as a package

    # Style guidance for the generation prompt (not imported as code).
    conventions:
      guides: [docs/e2e-guidelines.md]
      examples: [e2e/specs/sample_login.spec.ts]

  runn:
    testPath: runbooks/{feature}/{spec}.yaml
    runCommand: "runn run --verbose --capture {artifactsDir} {files}"
```

Three keys sit at the root rather than under a target, because each is a fact
about the project rather than about how one target compiles a test:

| Key | What it is |
|---|---|
| `envFiles` | dotenv files the project already keeps its test variables in, loaded before a recording resolves `${VAR}` — so those values are not duplicated into a ccqa profile. A named file that is not there is an error. |
| `sessionState` | a saved Playwright `storageState` JSON, restored before the browser is driven, so a case whose precondition is "signed in" records and replays no sign-in. Both `ccqa record` and a live run start from it. |
| `sourceRoots` | where the product's own source lives, for `ccqa audit` and the `ccqa evidence` table. See [Drift detection](./running.md#sourceroots--where-the-product-actually-lives). |

### `kind: external` — a target with no code of its own

The targets above ship with ccqa. A project may also define a target
entirely in config — no plugin, no code under `src/targets/` — for a test
framework none of the built-ins match. `kind: external` marks the target as
one ccqa does not own; `framework: playwright` says which compiler its
generated code targets (the only value accepted today). Everything else in
the block is the same configuration surface described in this document, so
an external target reads `resources`, `conventions`, `testPath`, and
`runCommand` exactly as `playwright` and `runn` do.

A fictional todo app that already keeps Playwright tests under `e2e/`, in
its own layout, might configure:

```yaml
targets:
  todoE2E:
    kind: external
    framework: playwright       # the only value accepted today

    # {case} is the case id an intent source assigns — see `intent` below
    testPath: e2e/{case}.spec.ts

    # directories generated support files may be created under; new files
    # only — `resources` below is what generated code may read
    writeRoots:
      - e2e/support

    runCommand: "pnpm exec playwright test --output {artifactsDir} {files}"

    # run over the whole repo after generation, not just the one test
    checkCommands:
      - "pnpm typecheck"

    resources:
      - path: e2e/pages
        description: page objects, one per screen

    conventions:
      guides: [docs/e2e-guidelines.md]
      examples: [e2e/support/sample.spec.ts]
      record: [docs/how-we-sign-in.md]   # read by the recorder, not the generator

    # a repo helper for unique values, called instead of ${CCQA_RUN_ID}
    runId:
      import: ./support/ids
      expression: generateRunId()

    hooks:
      stepEvidence: true   # default; false drops the per-step capture calls

    header: |
      // Generated by ccqa — do not hand-edit.

    titleTags:
      field: priority
      map:
        P1: critical
        P2: normal
      format: "[{value}]"

    # this target's cases are markdown, not spec.yaml — see `intent` below
    intent:
      kind: markdown
      root: docs/manual-tests
      fields:
        title: Title
        precondition: Preconditions
        steps: Test steps
        expected: Expected results
        cleanup: Teardown
        priority: Priority
        link: Ticket
        outputPath: Generated test   # omit to keep the case read-only
```

The keys not already covered elsewhere in this document:

- **`writeRoots`** — directories generated support files may be created
  under. Only new files, and only here: `resources` is what the generated
  code reads and imports, never what it may rewrite.
- **`checkCommands`** — commands run over the whole repository after
  generation (a type check, a lint). Separate from `runCommand`, which runs
  the one test: a generated file that breaks the project's build passes its
  own test and still cannot be merged.
- **`runId`** — `import` and `expression` for a repo's own helper that
  names the unique values a generated test creates, called instead of
  leaving `${CCQA_RUN_ID}` in the test.
- **`hooks.stepEvidence`** — on by default; off drops the per-step capture
  calls described in
  [Step screenshots for external targets](#step-screenshots-for-external-targets)
  below.
- **`header`** — the comment block the generated test opens with, as a
  template. `{case}`, `{title}`, `{priority}`, `{link.url}` and `{link.ref}`
  are filled in from the case; a line whose placeholders are all empty is
  dropped, so a case with no sheet link ships no empty `// sheet:` comment.
- **`titleTags`** — a tag the test's title ends with, taken from an intent
  field. `field` names which one; `map` says which field values become
  which tags — a value the map does not name emits no tag; `format` is the
  tag's shape, with `{value}` filled in.

### `resources` — code the generated test reuses

Each entry has exactly one of `path` (code inside this repo — a literal path
or a glob) or `package` (an installed npm package, imported by name), plus
an optional `description`. Either form works for page objects, step helpers,
fixtures, shared constants, or any other export the generated code can
reuse.

Generation is **reuse-first**: the mechanical compile always runs, and the
LLM rewrite pass runs only when `resources` is non-empty. The rewrite treats
the mechanical draft as recorded ground truth and only restructures it to
import your existing code instead of duplicating it. With no `resources`,
the draft ships as-is — no LLM involved for the playwright target.

### `conventions` — guidance for the model

`conventions` are prompt inputs, not imports. Entries may be globs.

- `guides` — convention documents, and `examples` — existing tests whose
  style the generated code should imitate. Both are read when generating.
- `record` — documents the *recorder* reads instead: how this project is
  signed into, which account a case's precondition names, anything that has
  to be true before the first step. It stays prose because a login is the
  part that differs most between projects, and mechanising it would put your
  vocabulary into ccqa.

### `testPath` — where the generated test lands

`testPath` is a template, expanded per spec:

| Placeholder | Expands to |
|---|---|
| `{feature}` | the feature directory name |
| `{spec}` | the test-case directory name |
| `{case}` | the case id an intent source assigns (below); only available when the target declares `intent:` |

Omit it and the test lands in the spec's own directory
(`.ccqa/features/<feature>/test-cases/<spec>/test.spec.ts`, or `runbook.yaml`
for runn) — the same convention as the agent-browser target, so every spec
carries its runnable test next to its `spec.yaml`. Set it to write into your
repo's own test tree instead.

The path is **derived, not recorded**: `ccqa run`, the drift audit, failure
triage and `ccqa perspectives` all expand the same template rather than reading
a manifest, so they find a spec's test whether or not it has been generated
yet. Generation is held to it too — the LLM rewrite pass may restructure the
test, but it cannot decide where the test lives. Support files it creates
(page objects and the like) go under a `resources` path root or beside the
test; those belong to your repo's layout, not to ccqa.

The template must be relative to the project root, must not contain `..`, and
must contain `{spec}` — without it every spec would generate onto one file.
`testPath` is not configurable for the `agent-browser` target: `ccqa run`
enumerates its vitest tests in the spec directory, so a configurable path there
would be read by the audit and ignored by the runner.

Whatever a generated test imports from inside the project — page objects, step
helpers, shared constants — is part of the test case as far as the audit and
failure triage are concerned. They follow the test's imports (relative
specifiers and `tsconfig.json` `paths` aliases, including a relative `extends`
chain, three hops deep, never into `node_modules`), so a selector living in a
page object is audited alongside the one in the test.

> **Breaking change:** `outDir` and the per-spec `generated.json` manifest are
> gone. Set `testPath` (or accept the spec-directory default) and delete any
> `generated.json` left in your spec directories — see
> [ADR-0028](./adr/0028-a-derived-test-path-and-a-recorded-route.md).

### `intent` — reading test cases from markdown

Omit `intent` and a target's cases are ccqa's own `spec.yaml` files. Set
`intent: { kind: markdown, root, fields }` and they are markdown files
under `root` instead, written in whatever headings the project already
uses — a team that keeps manual test cases as markdown keeps writing them
the way it does.

`fields` maps ccqa's own vocabulary onto the project's headings. Every key
is optional; an omitted one falls back to its English default:

| Field | Default heading | Holds |
|---|---|---|
| `title` | `Title` | the case's title |
| `precondition` | `Precondition` | context true before the case starts; handed to the recorder as prose, never parsed |
| `steps` | `Steps` | a numbered list of what to do (required) |
| `expected` | `Expected` | what must hold, for the case: a bullet list, or prose |
| `cleanup` | `Cleanup` | a numbered list run after the case, any outcome, plus what the undo must make true |
| `priority` | `Priority` | free text, kept as written |
| `link` | `Link` | a bullet list, `URL: ...` / `No: ...` items |
| `mode` | *(none)* | `live` runs the case through the browser agent; anything else records and generates |
| `outputPath` | *(none)* | heading ccqa writes the generated test's path into |

A case is one file. Level-2 (`##`) headings divide it into sections; a
deeper heading belongs to the section it sits in, so a case that structures
its steps with `###` is still one case. `steps` is the only section a case
cannot do without — without it there is nothing to record. `steps` and
`cleanup` are numbered lists (`1.`, `1)`, `1．`); the number is kept, not
renumbered, because it is how a step gets cited later. `expected` is a
bullet list (`-`, `*`, `+`, `・`) stated for the case as a whole, not tied
to one step — which step delivers which expectation is read off the
recording, not the markdown. A section written as a paragraph instead is
kept whole rather than dropped, so a case is never quietly weakened by its
punctuation; `cleanup` reads the same way. A heading the map does not name is carried
through unchanged, as context for whoever records the case.

A `cleanup` section that numbers its steps **and** lists bullets is stating
two things: the numbered items are the undo, and the bullets are what the
undo has to make true. Those are recorded and asserted inside the generated
`afterEach`, where they are true — asserting "the item is gone" among the
case's own steps would check it while the item still exists.

Using the field map above, a case file looks like:

```markdown
## Title

Mark a task complete

## Preconditions

A task named "Buy milk" already exists in the list.

## Test steps

1. Open the task list.
2. Click the checkbox next to "Buy milk".

## Expected results

- The task's checkbox is checked.
- The task's text is shown with strikethrough.

## Teardown

1. Uncheck the checkbox to restore the task.

- The task's checkbox is unchecked again.

## Priority

P1

## Ticket

- URL: https://example.com/tickets/123

## Generated test
```

`outputPath` is the one section of your file ccqa writes to, and it has no
default: name a heading and ccqa replaces that heading's body with the
generated test's path, leaving every other byte alone; name none and ccqa
only ever reads your cases. The heading has to already be in the file, even
with an empty body as above, for there to be a section to write into.

A case's **id** is its path below `root`, without the extension —
`docs/manual-tests/todo/mark-complete.md` under `root: docs/manual-tests`
has id `todo/mark-complete`. That id is what `{case}` expands to in
`testPath` (above), and the case's working files live under
`.ccqa/cases/<id>/`.

`mode` has no default either, and for the same reason: without a heading
named, no case in the project is claiming to declare one. Where it is set and
a case's section reads `live`, `ccqa run` executes that case through the
browser agent — the case's steps and its expectations, judged as it goes,
with its `cleanup` steps run afterwards — instead of expecting a compiled
test. Every other case is recorded and generated, and its test is run by your
own test runner (see [`ccqa select-specs --format
paths`](./running.md#asking-the-question-on-its-own)).

Two things ask ccqa to run a generated case anyway, through the target's own
`runCommand`: `--coverage`, because a measurement has to watch the test
execute to record what it reached, and naming the case, because that is
someone asking for this one. A plain `ccqa run` still leaves them alone — the
line is "who owns running this suite", and by default that is your runner.

### What the generated test looks like

Two things in the emitted file are written for the reviewer rather than for
the runner, and both are mechanical.

**Each step opens with the case's own words.** A step recorded from a markdown
case is commented `// step 3: <the step's sentence>`, and a cleanup step
`// cleanup 1: <…>` — so a reviewer reads the code against the case without
opening both. Under `--language ja` the same comments read `// 3. <文>` and
`// 後処理 1. <文>`. A `spec.yaml` step keeps the identifier form
(`// step: step-03 [spec]`) it has always had.

**The `afterEach` guard is assigned where the route created something.** With
`runId` configured, the test opens with the project's own unique value, and the
cleanup is guarded by a second variable that is only assigned once the route
has actually created a thing to undo:

```ts
test.describe("Add a todo item", () => {
  let ccqaCreated: string | undefined;

  test("Add a todo item @smoke", async ({ page }) => {
    const ccqaRunId = generateRunId();
    // step 2: Fill in the new item field with a unique title
    await page.getByPlaceholder("What needs to be done?").fill(`buy milk ${ccqaRunId}`);

    // step 3: Click the add button
    await page.getByRole("button", { name: "Add" }).click();
    ccqaCreated = ccqaRunId;
  });

  test.afterEach(async ({ page }) => {
    if (ccqaCreated === undefined) return;
    // cleanup 1: Delete the created item
    await page.getByRole("button", { name: "Delete" }).click();
  });
});
```

The assignment's position is decided by a rule, not by a model: the first
action that submits (a click, a double click, a key press) after the first one
that typed the unique value, at the end of that action's step. A route that
never submits the value, or never types it, assigns at the end of the test —
later than the creation, never earlier.

### Credentials

A recording carries `${VAR}` references, never the values they resolved to,
and it does so for **every variable ccqa itself loaded** — an `envFiles` entry,
a hub profile — whether or not the case mentions it by name. A case written as
prose ("sign in as the test account") never names those variables, which is
exactly the case that used to bake them in. Values shorter than eight
characters are left alone: a port or a stage name matches ordinary page text
more often than it protects anything, and naming such a variable in the case's
own text still gets it the exact treatment.

Two things follow from that rule:

- **A password typed literally is not recorded.** Where the value resolved to a
  reference the action is kept; where it did not, the action is dropped and the
  log says to put the value in a file named by `envFiles` and record again.
- **A generated file holding one of those values is refused.** The rewrite pass
  is asked again, twice, and then the generation fails. It is not rewritten
  into a `${VAR}`: a credential a model wrote into a comment is not a reference
  the test needs.

`ccqa generate` also reads the saved route back and names any variable whose
resolved value it still holds — a recording made before the project pointed
ccqa at its env file keeps those literals, and nothing else would look.
`ccqa evidence` puts its table through the same map before writing it, because
that table exists to be pasted somewhere public.

See [ADR-0031](./adr/0031-a-recording-carries-references-not-values.md).

### `ccqa evidence` — the table a reviewer reads instead of the test

`ccqa evidence <case>` writes a markdown table pairing what the case says
with what was recorded, what the generated test actually decides, and the
screenshots from the last run — so the case's author and its reviewer can
check the two against each other without reading the test file.

```sh
ccqa evidence todo/mark-complete                  # writes .ccqa/cases/todo/mark-complete/evidence.md
ccqa evidence todo/mark-complete -o review.md     # somewhere else
ccqa evidence todo/mark-complete --report-dir ci-report
```

The column that earns the table is **What the test decides**: a step that is
performed but whose outcome nothing checks reads `**nothing**`, which is the
thing a reviewer cannot see by skimming a spec file. The table's own Review
section is derived from that column — every step reading `**nothing**` is
listed there, so the summary can never say "every step is decided" above a
table that shows otherwise.

The **Screens** column links the step screenshots the last `ccqa run` left. A
project whose generated tests belong to its own runner never calls `ccqa run`,
so where there is no such report the screenshots the generation's own
verification took stand in — the same file pair, of the same test passing,
kept under `.ccqa/cases/<id>/evidence/`. Only the attempt that passed is kept;
a generation that never passed leaves none. Beside `runs/`, not inside it: a
project gitignores `runs/`, and a review table linking into it would resolve to
nothing once pasted into a pull request.

With [`sourceRoots`](./running.md#sourceroots--where-the-product-actually-lives)
configured, a **Where the source says so** column is added: each test id,
accessible name, placeholder, label and asserted text the recording used,
resolved to the `file:line` in the product's own source that renders it, or
`not found`. It is a plain exact-match search — no model, bounded in files
read — so it answers "is this locator addressing the thing the case means?"
without anyone having to go and look.

The first match is not the answer, because a string a screen renders also
appears in the document that specified the screen and the script that seeded
it. Candidates are ranked, and only the best rank is reported:

1. a file that renders a screen — a component or a server-side template;
2. a translation catalogue, under a directory named for one (`i18n`, `locales`,
   `messages`, …);
3. any other application code.

A path under `docs/`, `scripts/`, `test/`, `fixtures/`, `examples/`, a seed or
a migration is not the product, and neither is a comment line — hits there are
dropped rather than ranked last, so the column answers `not found`, which is
the true answer about what the product renders. A test id matches only where it
is declared as an attribute (`data-testid="…"` and its usual spellings), never
where a selector or a comment names it. When several places share the top rank
the cell reads `ambiguous` and shows two of them rather than picking one: the
scan stops once it has those two, so it offers no tally it did not finish.

Within a file the line is chosen, not taken. The first occurrence is the wrong
answer often enough to matter — a label's text also appears in the constant
that defines it and in the analytics event that fires with it, and those
usually come first — so a line where the string is the whole value of an
`aria-label`, `label`, `placeholder`, `name`, `title` or `alt`, or sits
between a `>` and a `<` as element text, beats one where it merely appears. A
hit found only glued inside a longer word is reported as a `(partial match)`:
a locator that matches by substring does work, but "the product renders this
string" is not what was found.

### Regenerating from a saved route

`ccqa generate` recompiles `ir.json` without a browser or a trace, which is how
a whole suite is re-emitted after a page object or a convention changes. One
thing makes that pointless, and it is refused rather than warned about: **the
recorded route no longer replays.** ccqa replays the saved actions once against
a fresh browser session — the same post-trace validation `record` runs, no
model involved — and refuses when the route is gone, since re-emitting a dead
route can only produce a test that cannot pass. `--no-replay` skips the check
for environments with no browser or no variables. It does not run under `ccqa
record`, which has just recorded and validated the route it is compiling.

The replay starts from the project's `sessionState`, like a recording does,
and skips the actions carrying this run's unique value — the record they made
is not there now, so their failure says nothing about whether the route holds.

One kind of failure the replay repairs instead of reporting. A field addressed
by its label (`getByLabel("Email")`) needs the page to associate a `<label>`
with the input; many forms show the same string as the field's accessible name
and associate nothing, so the recorder — reading that string off a snapshot —
records a locator that matches nothing. The replay retries such an action once
by role and accessible name (`getByRole("textbox", { name: "Email", exact: true
})`), and where that works the saved route keeps the form that replays, with a
line in the log saying so. It applies only where the element's role is not in
doubt: a `fill` or a `type` is a textbox, a `check` is a checkbox, and a
labelled `click` could be any of several things, so it is left as a failure.

When an action does fail, the report names the one that failed rather than the
size of its wake: everything after it in the same step is not replayed at all,
and is counted as such.

**A hand-edited test is not regenerated over.** `ccqa generate` stamps
`ir.json` with the sha256 of the test it wrote (`generated: { testSha256, at }`
— one field on a file you already commit, not a second artifact). Next time it
compares the test on disk against that stamp:

| The test is | `ccqa generate` |
|---|---|
| what ccqa last wrote | regenerates it, without asking |
| different from it | refuses — the edit is work; re-record, or repair it in your repo (`--overwrite` regenerates anyway) |
| unstamped (never generated, or recorded by an older ccqa) | asks y/N; a non-TTY declines |

Only `ccqa generate` reads that stamp to decide anything. `ccqa run` and the
audit's verdict never do — the generated test is yours, and neither should
answer differently because of who last wrote it. The one other reader is
[`ccqa audit --brief`](./running.md#--brief--findings-for-whatever-repairs-the-test),
which needs it to tell a fix job whether regenerating would discard someone's
work; that is routing, beside the verdict, not part of it.

### The recorded route, and what a re-record changed

`ir.json` is the record of the route a recording actually took — its
operations, locators, values and checks — plus when it was recorded, which
entry point it started from (`${VAR}` references left unexpanded), and what the
last `ccqa generate` wrote from it. It is what makes browser-free regeneration
possible, and it dates the test's origin.

Re-recording replaces the route wholesale, so `ccqa record` writes a
`route-diff.md` beside the spec whenever it replaced an existing recording:
what was added, removed, or changed, grouped by spec step.

```md
## step-02 — Submit the form

- changed: `click text="Submit"` → `click role=button[name="Submit"]`
- added: `assert text_visible "Saved"`
```

### `serialGroups` — specs that must not run at the same time

Raising `--concurrency` runs specs at the same time, which is safe until two
of them write to the same place outside your app: a chat channel, a shared
inbox, a single seeded account. The failure that follows does not look like a
failure — each spec asserts on what it posted and finds the other one's, so
the run goes green or red at random and gets written off as flake.

`serialGroups` is a top-level key in `.ccqa/config.yaml`, sitting alongside
`defaultTarget` and `targets`. The key names the shared thing (a slug: letters,
digits, `.`, `_`, `-`); the list names the specs that write to it:

```yaml
serialGroups:
  notification-channel:
    - notifications/post-message
    - notifications/reply-thread
```

`ccqa run` never runs two members of one group at the same time. Specs
sharing no group still run in parallel, so the cost of protecting a few
specs is not paid by the rest. It applies to every target and both modes,
because the conflict is with the outside world rather than with how the spec
is driven.

Every member is validated against the project's spec inventory: a name that
does not resolve to a real `<feature>/<spec>` is a hard error at run time,
not a silently shrunk group. `ccqa run --dry-run` echoes the groups it read
as `serial: <group-name(s)>` on each affected spec's line, which is how you
confirm a group was read rather than mistyped into silence.

Within one run, `ccqa run` serialises specs sharing a group. Across runs —
with `--only-hub-rerun-needed`, which is where the hub and profile are
resolved — the group is claimed on the hub alongside the specs themselves,
so a second cycle starting while the first is still going leaves those specs
for next time instead of running them into each other. That claim is per
profile, so two profiles reaching the same external service need the
distinction inside the group name (`tenant-a.notification-channel`). See
[ADR-0015](./adr/0015-serial-groups-in-one-place.md).

## `runCommand` — how `ccqa run` executes a target

If a target's config sets `runCommand`, `ccqa run` executes its generated
tests with that command and folds the results into the same report as the
agent-browser specs. Without `runCommand`, the target is generate-only:
`ccqa run` lists its specs as **skipped** instead of silently dropping them.

`runCommand` supports two template variables:

- `{files}` — the spec's generated test files (shell-quoted, cwd-relative).
- `{artifactsDir}` — a per-spec directory
  (`<report-dir>/artifacts/<feature>__<spec>/`) created before the command
  runs. Everything the command leaves there (screenshots, traces, result
  JSON) is recorded as the spec's **artifacts** in the run report, next to
  an always-captured `output.log` of the command's stdout+stderr — so even a
  passed run shows what ran. The directory is also exported to the command
  as `CCQA_ARTIFACTS_DIR`, for tools that can't take it as a flag.

The command also runs with a fresh per-spec `CCQA_RUN_ID` in its
environment — the same contract as the vitest runner, so specs that embed
`${CCQA_RUN_ID}` in created-content names stay collision-free across specs
and runs.

Artifact collection is capped (50 files / 32 MB per spec); anything dropped
is named in a warning, never silently cut. The examples above use
`--output {artifactsDir}` (Playwright: failure traces land in the report)
and `--capture {artifactsDir}` (runn: run captures land in the report).

A failing `runCommand` spec is triaged like any other: with
`ccqa run --on-fail-explain` it gets the same root-cause call and
spec↔code drift audit as an agent-browser spec, built from its generated
test files, the command's output tail, and its `spec.yaml` — see
[Failure triage](./running.md#failure-triage). When the command left a
Playwright `error-context.md` (an accessibility snapshot at the point of
failure) in the artifacts dir, the classifier reads it for extra context.

## Step screenshots for external targets

Playwright specs capture the same per-step **before/after screenshots** an
agent-browser run produces, rendered identically in the hub. You configure
nothing: ccqa's emitter injects `ccqa/step-evidence` calls at each spec-step
boundary of the generated test, and `ccqa run` points the test at the
report's evidence directory through `CCQA_EVIDENCE_DIR`. The calls no-op when
that variable is unset, so running the generated test yourself writes no stray
files.

`ccqa/step-evidence` ships with ccqa — the consumer installs nothing, and ccqa
gains no Playwright dependency (the page is typed structurally). It is
published as both ESM and CommonJS, so a suite with no `type: "module"` — most
Playwright suites — can `require()` it: without that the import fails at
resolution, the run reports that it found no tests, and a fix pass removes the
import to make the failure go away, leaving a spec with no screenshots at all.

Your `tsconfig.json` has to resolve subpath exports, which means
`"moduleResolution"` of `bundler`, `node16` or `nodenext`. The older `node`
setting predates the `exports` field and reports `ccqa/step-evidence` as having
no type declarations (TS2307), whichever build it would have loaded at run
time.

Capture is best-effort: a failed screenshot is logged and skipped, never a test
failure. A rewrite pass that dropped a step's two capture calls is rejected and
asked again, and a second failure fails the generation — the report would
otherwise silently miss that step's screenshots. A step no recorded action
belongs to gets no boundary at all, and is named at generation time: re-record
the case.

This is orthogonal to `--trace`: keep `trace` in your `playwright.config.ts`
(or the `runCommand`, e.g. `--trace retain-on-failure --output {artifactsDir}`)
for the full time-travel trace, which rides along as a run **artifact**. ccqa
handles the step screenshots; Playwright still owns the trace. Targets with no
browser (`runn`) capture no screenshots and say so in the report.

A spec with a `judgeByLlm` claim also runs standalone under your own
`runCommand` (plain `playwright test`) — see its runtime contract in
[spec.md](./spec.md#running-a-judged-test-outside-ccqa-run).

## Per-target guidance prompts

Like `record` and `live`, each LLM-generating target has a hub-stored
guidance pair (`playwright.user` / `playwright.agent`, `runn.user` /
`runn.agent`) injected into its generation prompt. Edit the `.user` file
locally under `.ccqa/prompts/` and upload it with `ccqa hub prompt push
<name>`; see [Hub](./hub.md).
