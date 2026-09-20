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
generate step. The recording is committed beside the test it compiles into —
see [The recorded route](#the-recorded-route-and-what-a-re-record-changed).
Spec-input targets (`runn`) have no recording step; `ccqa generate` is where
generation starts.

```bash
ccqa record tasks/create-and-complete     # recording targets: trace + generate
ccqa generate api/create-task             # spec-input targets: generate only
ccqa generate tasks/create-and-complete   # recording targets: re-run generate
                                          # from the saved ir.json
```

- Running `ccqa record` on a spec-input target exits 2 with a pointer to
  `ccqa generate`. Running `ccqa generate` on a recording target that has no
  recording errors with "No recording found", naming the files it looked in.
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

    # {case} is the case id your own case source assigns — see `cases` below
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
      operate: [docs/how-we-sign-in.md]  # read by record/live run, not generate

    # a repo helper for unique values, called instead of ${CCQA_RUN_ID}
    runId:
      import: ./support/ids
      expression: generateRunId()

    hooks:
      stepEvidence: true   # default; false stops ccqa capturing step screenshots

    # may the generated teardown contain `expect`? default true
    allowExpectInCleanup: false

    header: |
      // Generated by ccqa — do not hand-edit.

    titleTags:
      field: priority
      map:
        P1: critical
        P2: normal
      format: "[{value}]"

    # this target's cases come from a module of yours, not from spec.yaml
    # — see `cases` below
    cases: ./ccqa/cases.mjs
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
- **`hooks.stepEvidence`** — on by default; off stops ccqa capturing the
  per-step screenshots described in
  [Step screenshots for external targets](#step-screenshots-for-external-targets)
  below. It changes nothing in the generated file.
- **`allowExpectInCleanup`** — whether the generated undo may assert. On by
  default. A case can state what its teardown must make true, and ccqa checks
  it where the teardown runs — inside the emitted `test.afterEach`. Some suites
  forbid that, because an assertion there turns a slow or partial teardown into
  a failed test, which reports the feature as broken when it is not; others
  want the undo checked like anything else. Both are coherent, so the project
  says which it is. Turning it off emits the undo's actions and nothing else —
  and `ccqa evidence` then names the cleanup expectations that nothing checks,
  so the trade is visible to whoever reads the table.
- **`header`** — the comment block the generated test opens with, as a
  template. `{case}` and `{title}` are always available, and every name your
  case source puts in `fields` besides; a line whose placeholders are all
  empty is dropped, so a case with no sheet link ships no empty `// sheet:`
  comment.
- **`titleTags`** — a tag the test's title ends with, taken from one of the
  case's `fields`. `field` names which one; `map` says which field values
  become which tags — a value the map does not name emits no tag; `format`
  is the tag's shape, with `{value}` filled in.

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
  A `guide` states rules in prose, so it is also read back. Once the
  project's own checks pass — and before the test is run, because code a
  reviewer would send back is not worth running — the emitted files go to a
  reader that knows nothing about where they came from. It opens them
  itself, along with the support files the test imports, whether this run
  wrote them or reused them, and whatever else in the repository it needs.
  A rule one of the guides states in its own words is quoted back; so is a
  convention no document states but the suite follows everywhere, reported
  with the count that shows it. What that reader would hold the change for
  spends a fix round, and what it would mention and approve anyway is only
  reported. A generation with no fix round to spend (`--auto-fix skip`) does
  not ask that reader at all; what ccqa reads out of the file itself still is.
  `examples` are not read this way, because a file that shows a shape states
  no rule to quote.
- `operate` — documents read by both `ccqa record` and a live `ccqa run`: how
  this project is signed into, which account a case's precondition names,
  anything that has to be true before the first step. The same guidance serves
  both, because how the application is operated does not change between
  recording a case and running one live. It stays prose because a login is the
  part that differs most between projects, and mechanising it would put your
  vocabulary into ccqa.

### `testPath` — where the generated test lands

`testPath` is a template, expanded per spec:

| Placeholder | Expands to |
|---|---|
| `{feature}` | the feature directory name |
| `{spec}` | the test-case directory name |
| `{case}` | the case id your own case source assigns (below); required when the target declares `cases:` |

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
must contain `{spec}` or `{case}` — without one of them every case would
generate onto the same file. A target with a `cases` module needs `{case}`
specifically (see below).
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

### `cases` — a reader you own

Omit `cases` and a target's cases are ccqa's own `spec.yaml` files. Set
`cases` to a module in your repository and ccqa asks that module instead:

```yaml
targets:
  e2e:
    kind: external
    framework: playwright
    testPath: "specs/{case}.spec.ts"
    cases: ./ccqa/cases.mjs
```

ccqa reads one format — its own. Everything else is your format, and it
stays yours: the module knows your headings, your columns, your tracker's
API, and ccqa never learns any of it. What crosses the line is the contract
below, and nothing else.

**The contract.** The module default-exports a function of the project root
and returns two methods:

```ts
type CaseSourceFactory =
  (ctx: { cwd: string }) => CaseSource | Promise<CaseSource>;

interface CaseSource {
  /** Every case id this source holds, sorted. */
  list(): Promise<string[]> | string[];
  /** One case, by its id or by the path a CLI argument named. */
  load(ref: string): Promise<Case> | Case;
}
```

A `Case` is a plain object:

| Field | Required | Holds |
|---|---|---|
| `id` | yes | `/`-separated path, no extension — `todo/mark-complete` |
| `path` | yes | absolute path of the file that states the case |
| `text` | yes | that file verbatim; the audit and the failure classifier read it as written |
| `title` | yes | the case's title |
| `mode` | yes | `"deterministic"` (record and compile) or `"live"` (drive it every run) |
| `steps` | yes | `{ instruction, expected? }`, at least one |
| `cleanup` | no | the same, run after the case whatever its outcome |
| `expectations` | no | what must hold for the case as a whole, unattached to a step |
| `cleanupExpectations` | no | what the undo must make true; asserted inside `afterEach` |
| `context` | no | `{ heading, body }` sections ccqa does not act on, handed to the recorder |
| `fields` | no | values `header` and `titleTags.field` refer to, by your own names |
| `disabled` | no | in the source, but out of runs and audits |

`cases` is a `kind: external` setting — a target ccqa ships brings its own
cases, so declaring it on one is refused.

`list()` defines the sweep — what `ccqa audit` checks and what `ccqa run`
expands "all cases" to — so return only what you can load: a README sitting
beside your cases is not a case. ccqa sorts and de-duplicates what you return.
A `load()` that throws stops whatever was asked to act on that case, reported
in your own words; ccqa never reads a failure as an empty answer.

The case is read **strictly**: an unknown key is refused rather than ignored,
so a typo is reported where it was made instead of quietly costing a field.
An `id` is `/`-separated with no leading `/`, no `..` and no backslashes —
normalise Windows separators before returning one.

Step numbering, where the case's working files live and where its recording
goes are ccqa's, decided by ccqa. A reader that assigned them would be
answering for a directory it cannot see.

**Getting the types.** Install nothing: the contract ships as the
`ccqa/case-source` subpath, and it is types only — the module imports nothing
from ccqa at runtime, so ccqa's own dependencies never reach your build. The
`@type` on the default export is what binds the reader to the contract; a
project that runs `checkJs` annotates its own helpers as it would in any
JavaScript file.

```js
// ccqa/cases.mjs
// @ts-check
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = "docs/testcase";

/** @type {import("ccqa/case-source").CaseSourceFactory} */
export default function cases({ cwd }) {
  const root = resolve(cwd, ROOT);

  return {
    async list() {
      const names = await readdir(root, { recursive: true });
      return names.filter((name) => name.endsWith(".md")).map(toId);
    },

    async load(ref) {
      // Both spellings reach the same case: the path you see in your editor,
      // and the id everything else cites.
      const id = toId(ref.startsWith(ROOT) ? relative(ROOT, ref) : ref);
      const path = join(root, `${id}.md`);
      const text = await readFile(path, "utf8");
      const section = (heading) => sectionOf(text, heading);
      return {
        id,
        path,
        text,
        // `|| id` because a case with no title still has to have one.
        title: firstLine(section("Title")) || id,
        mode: firstLine(section("Mode")).toLowerCase() === "live" ? "live" : "deterministic",
        steps: listItems(section("Steps"), /^\s*\d+[.)]\s*/).map((instruction) => ({ instruction })),
        cleanup: listItems(section("Cleanup"), /^\s*\d+[.)]\s*/).map((instruction) => ({ instruction })),
        expectations: listItems(section("Expected"), /^\s*[-*]\s*/),
      };
    },
  };
}

/** A path below the root, or an id already in that form, as an id. */
function toId(name) {
  return name.replace(/\.md$/, "").split(/[\\/]+/).join("/");
}

/** One `## Heading` section's body; deeper headings stay inside it. */
function sectionOf(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** Every line of `body` that starts with `marker`, with the marker removed. */
function listItems(body, marker) {
  return body
    .split("\n")
    .filter((line) => marker.test(line))
    .map((line) => line.replace(marker, "").trim())
    .filter(Boolean);
}

function firstLine(body) {
  return body.split("\n")[0]?.trim() ?? "";
}
```

**Plain JavaScript.** ccqa imports the module with no loader, so it must be
`.mjs`, `.js` or `.cjs` — a `.ts` file cannot be read, and ccqa says so
rather than failing obscurely. `// @ts-check` checks it in your own `tsc` run
without a build step; point `cases` at compiled output if you would rather
write TypeScript. (The rule
that a generated test may not import `ccqa/*` applies to emitted tests only
— a reader module is not a test, and it imports the subpath as a type
anyway, which erases.)

**`{case}` is required.** A case is addressed by its whole id, so a target
with a `cases` module must use `{case}` in its `testPath`: `{spec}` is only
the last segment, and two cases filed under the same name in different
directories would generate onto one file. The id is also where the case's
working files live — `.ccqa/cases/<id>/` holds its evidence, its route diff
and its lock. Not its recording: that is committed beside the test, at the
`testPath` ([The recorded
route](#the-recorded-route-and-what-a-re-record-changed)).

**`titleTags.field` names one of your `fields`.** ccqa has no list of valid
names to check it against, so a name your reader never sets simply emits no
tag rather than an error. Grep your own reader if a tag goes missing.

**`mode` decides who runs the case.** `live` has `ccqa run` drive it through
the browser agent — the case's steps and its expectations, judged as it
goes, with its `cleanup` afterwards — instead of expecting a compiled test.
Every other case is recorded and generated, and its test is run by your own
runner (see [`ccqa select-specs --format
paths`](./running.md#asking-the-question-on-its-own)).

Two things ask ccqa to run a generated case anyway, through the target's own
`runCommand`: `--coverage`, because a measurement has to watch the test
execute to record what it reached, and naming the case, because that is
someone asking for this one. A plain `ccqa run` still leaves them alone — the
line is "who owns running this suite", and by default that is your runner.

> **Breaking change:** `intent: { kind: markdown, root, fields }` is gone,
> and so is its `outputPath` write-back — ccqa no longer edits your case
> files. Move the reading into a module of your own and point `cases` at it;
> a config that still declares `intent` is refused with that instruction.
> See [ADR-0034](./adr/0034-ccqa-reads-one-format-and-is-handed-the-rest.md).

### What the generated test looks like

Two things in the emitted file are written for the reviewer rather than for
the runner, and both are mechanical.

**Each step opens with the case's own words.** A step recorded from a case
your own source stated is commented `// step 3: <the step's sentence>`, and a
cleanup step
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

A row is one line tall wherever it can be. A step's operations fold behind
their count once there are more than a couple, and signing in — everything the
recording did before the case's first step — is stated once above the table
rather than inside the first step's row, where it would make that step look
like it does all of it. Any action the recorder could not attribute to a step
is stated there too, rather than disappearing.

The **Screens** column links the step screenshots the last `ccqa run` left. A
project whose generated tests belong to its own runner never calls `ccqa run`,
so where there is no such report the screenshots the generation's own
verification took stand in — the same file pair, of the same test passing,
kept under `.ccqa/cases/<id>/evidence/`. Only the attempt that passed is kept;
a generation that never passed leaves none. Beside `runs/`, not inside it: a
project gitignores `runs/`, and a review table linking into it would resolve to
nothing once pasted into a pull request.

The table is written in the run's `--language`, so a Japanese project gets a
Japanese table without configuring anything. Its **headings** can also be put
in the project's own vocabulary:

```yaml
# .ccqa/config.yaml
evidence:
  labels:
    step: 手順
    decides: テストが判定していること
```

Only the keys the table prints are accepted, so a misspelt one is a config
error rather than a setting that silently does nothing.

What the table *concludes* is not among them. `nothing`, and the Review
section's wording, are ccqa's own and translated by ccqa: a project able to
reword them could make a step nothing checks read as one that passed, and the
table is read by people who did not write that config.

With [`sourceRoots`](./running.md#sourceroots--where-the-product-actually-lives)
configured, a **Where the source says so** column is added: each test id,
accessible name, placeholder, label and asserted text the recording used,
resolved to the `file:line` in the product's own source that renders it. It is
a plain exact-match search — no model, bounded in files read — so it answers
"is this locator addressing the thing the case means?" without anyone having
to go and look.

Only a string the scan pinned to exactly one place gets a line of its own. The
column is read as "the product really says this", and a string found nowhere,
never searched for, or found in several files equally does not answer that —
those fold behind their count, where a reviewer who wants them can still open
them.

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
and **resolves `${CCQA_RUN_ID}` to a value of its own**. A route that creates
something names it after the run that created it, so a replay that skipped
those actions would submit the form without the name and then wait for a
confirmation that could never arrive — the route would read as dead because
the check declined to walk it. One fresh value is used everywhere the route
uses the reference: the fill that types it, the assertion that reads it back,
the click that acts on it. `ir.json` keeps the reference; the value belongs to
that replay and is never written back.

This means the check **drives your application for real**, side effects
included: it performs the recorded actions, so whatever the route creates, it
creates. The case's recorded cleanup, where it has one, is attempted straight
after with the same value — but only after a route that replayed whole. A
cleanup locator is rarely scoped to the run id, so undoing a route that created
nothing removes whatever was already there. What remains is an attempt, not a
guarantee: a cleanup that does not fully replay is reported and never refuses
the regeneration, because a tidy-up that failed says nothing about whether the
route holds. So **a replay can leave changes behind** — after a route that
broke, after a cleanup that did not replay, and on a case that records no
cleanup at all. The check says so in each case. `--no-replay` skips the check,
side effects and all.

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

The other repair is about how a locator was written down. **`agent-browser get
count` takes plain CSS and nothing else — handed Playwright's own notation
(`text=`, `role=`, `:has-text()`, `internal:`) it answers `0` rather than
failing**, and a zero reads as an element that is not there. An
`element_visible` assertion recorded as `text=<string>` is checked with `get
count`, so a page that plainly shows the string reported a dead route.

An assertion whose locator is not CSS is therefore asked the way it addresses
the element — `wait --text`, or `find role … text --name --exact` — rather than
counted. Notation that cannot be converted, and one that names nothing, are
reported as **unverifiable** rather than absent. Recording stores a `text=`
probe as a text locator at the source, so a case recorded from here never takes
the shape that fails; a `role=` one is asked by name but left in the route
exactly as recorded, and an *interaction* written `click "text=…"` is left
alone too, because that one does work.

The same holds for an accessible name written as an attribute. A recorder
reads `combobox "Priority *"` off a snapshot and writes
`[aria-label='Priority *']`, but a name can come from an associated `<label>`
or from `aria-labelledby`, in which case there is no such attribute and the
count is zero. An attribute selector that counted nothing is therefore asked of
the accessibility tree the name came from, and where a node carries it the
route keeps the role and name — which the replay and the generated test then
probe with the same `find role … text --name … --exact`.

**When a replay says an element is missing and you can see it.** Open the same
session and compare three answers: `agent-browser --session <name> snapshot`
for the accessibility tree, `get count "<the recorded selector>"`, and `get
count "<some tag the page certainly has>"` — the last as a probe only, never as
a selector to record. The element in the snapshot with its own selector at zero
and the generic one at many is a selector-form problem, and no amount of
waiting changes it. The element missing from the snapshot, or a generic count
of zero, is the session: wrong page, wrong tenant, or a sign-in that did not
restore.

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

It lives beside the test it compiles into, named by replacing that test's
final extension with `.ccqa.ir.json`: a case emitted to
`specs/todo/add.spec.ts` keeps its route in `specs/todo/add.spec.ccqa.ir.json`,
and the two halves of a recorded case — the route and the code — are committed
together in one directory. A recording an earlier ccqa left in the case's own
directory under `.ccqa/` is still read, and whatever writes it next — a
`record`, a `generate`, a repaired locator — puts it beside the test and
removes the old file.

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
  runs. Everything the command leaves there (screenshots, result JSON) is
  recorded as the spec's **artifacts** in the run report, next to an
  always-captured `output.log` of the command's stdout+stderr — so even a
  passed run shows what ran. The one exception is a Playwright `trace.zip`:
  it is listed only for a spec that failed, because the step screenshots
  have already been read out of it and the archive is worth opening only to
  replay a failure. It stays in the directory either way. The directory is
  also exported to the command as `CCQA_ARTIFACTS_DIR`, for tools that can't
  take it as a flag.

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

Playwright specs carry the same per-step **before/after screenshots** an
agent-browser run produces, rendered identically in the hub. You configure
nothing, and the generated test contains nothing of ccqa's: each of the case's
steps is a native `test.step("step 1: ...", ...)` block, and the screenshots
come from the run's Playwright **trace**, which ccqa asks for and reads back
after the command has exited. Nothing runs inside your test that could fail it,
and the committed file typechecks in a repository where ccqa is not installed.

For ccqa to get a trace, the target's `runCommand` has to invoke `playwright
test` itself — `pnpm exec playwright test {files}`, not a package script that
wraps it. ccqa appends `--trace=on` and `--output=<its own artifacts dir>`, and
refuses to amend a command that uses shell operators or already directs
`--output` somewhere else. When it cannot, the row says so instead of showing an
empty section.

The frames are the trace's screencast — the filmstrip the trace viewer
shows — so they are downscaled JPEGs rather than full-page captures. That is
the price of keeping the capture code out of the file you commit.

A step's screenshots are matched to the case by the `test.step` title, which is
the same label the draft writes. A rewrite pass that reshapes a title is
rejected and asked again, and a second failure fails the generation — the
evidence table and the run's screenshots both read it back, and a reshaped one
makes every step report as deciding nothing. A step no recorded action belongs
to gets no block at all, and is named at generation time: re-record the case.

Set `hooks.stepEvidence: false` on the target to opt out. The generated file is
unchanged either way; what stops is ccqa asking for a trace and reading it.

A spec generated by an earlier ccqa imports `ccqa/step-evidence` and captures
its own, higher-fidelity, screenshots. That subpath still ships and `ccqa run`
still points `CCQA_EVIDENCE_DIR` at the report directory for it, so such a spec
keeps working until it is regenerated; the export is removed in a later
release. Targets with no browser (`runn`) capture no screenshots and say so in
the report.

The full time-travel trace is written either way, so `--trace` in your own
`playwright.config.ts` still does what it always did. A failed spec lists it
as a run **artifact**; a passed one leaves it in the artifacts directory
without listing it.

A spec with a `judgeByLlm` claim also runs standalone under your own
`runCommand` (plain `playwright test`) — see its runtime contract in
[spec.md](./spec.md#running-a-judged-test-outside-ccqa-run).

## Per-target guidance prompts

Like `record` and `live`, each LLM-generating target has a hub-stored
guidance pair (`playwright.user` / `playwright.agent`, `runn.user` /
`runn.agent`) injected into its generation prompt. Edit the `.user` file
locally under `.ccqa/prompts/` and upload it with `ccqa hub prompt push
<name>`; see [Hub](./hub.md).
