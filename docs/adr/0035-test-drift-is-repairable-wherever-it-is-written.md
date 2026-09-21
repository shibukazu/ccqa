# 0035. TEST_DRIFT is repairable wherever it is written

- Status: accepted (its `--brief` output replaced by `audit.json` in ADR-0036)
- Date: 2026-09-21

Amends "Routing is not evidence" in
[ADR-0030](0030-the-audit-reads-the-product.md).

## Context and problem statement

`ccqa audit --brief` routes each finding to whatever repairs the test, and
until now it offered a machine only one repair: regenerate. Eligibility
required `TEST_DRIFT` on the `generated` surface, because that is the surface
a regeneration rewrites.

A renamed string does not respect that boundary. A project that states its
cases in its own documents quotes the strings it expects, so when the product
renames one, the document and the generated code go stale together — and the
audit answers `spec`, which is the tie-break ADR-0030 asked for and the right
answer to the question it was asked. The finding then routed `external` and
waited for a person, for a repair that is one string long.

The crux is that regenerating does not fix it: the same stale document
compiles to the same stale test. Auto-repair here means editing the document
first, then rebuilding and verifying — which is the sequence the audit prompt
has described all along and the routing declined to offer.

A second crux appeared once that was built and exercised end to end.
`ccqa generate` replays the saved recording before recompiling it and refuses
one the application has outgrown (ADR-0028). A recording holds the strings it
drove the browser with — an asserted label, a locator's accessible name — so
a renamed label is in the recording too, and regenerating cannot repair it.
The repair is to record the case again. A single machine route therefore named a
command that would drive the application for real and then decline.

## Considered options

- **Widen `regenerate` to include `TEST_DRIFT` on the `spec` surface.** One
  fewer state. Rejected on the meaning rather than on compatibility: a caller
  that regenerates and stops would recompile the stale document, see the
  finding again, and repeat — the route would be promising a repair it does
  not perform.
- **Two values, with a `rewrite` payload carrying the document edit.** Built
  first, and rejected on the evidence above: because a renamed string is
  almost always in the recording as well, the one machine route named the
  command that refuses. A route value that names a *different command* is not
  the redundant state a route value restating the payload would have been —
  `rewrite` says which strings to replace, and only the route says what to run
  afterwards.
- **Keep live cases `external`.** Held briefly, on the reasoning that a live
  case has no regeneration to verify a rewrite. Rejected: a live case is
  verified by running it, which is what a live case always was — the model
  executes the document against the product. Excluding them would have denied
  the repair to exactly the cases whose document *is* the test.
- **Find the stale string by parsing the finding's prose.** ccqa already
  extracts quoted runs to verify citations, so the machinery existed.
  Rejected: the pattern knows one set of quote characters and drops runs under
  three characters, so a finding written in another language names nothing it
  can see. Teaching a regex more languages is how a general-purpose tool
  starts learning one project's punctuation, which is what ADR-0034 exists to
  stop. The same argument rules out a minimum length on the strings the audit
  does name: how short is too short to mean anything is a fact about a written
  language, not about test cases.
- **Have ccqa apply the edit itself.** Rejected outright: ADR-0034 removed the
  one place ccqa wrote to a case document, and the case-source contract is
  read-only. ccqa does not know the format it would be editing, and reversing
  that here would reverse ADR-0034 in the release after it.

## Decision outcome

Chosen: **the audit names the rename, ccqa checks it against each file that
could hold it, and the route names the command that repairs the case.**

The audit answers a `renames` array beside its diagnosis — `{ from, to }`
pairs, verbatim, scoped to `TEST_DRIFT`. It sits beside the verdict rather
than inside it, as `locators` already does, because a rename is an aid to the
repair and not part of the finding: nothing on the wire carries it, and a
malformed one is forgiven rather than allowed to cost a verdict the sweep has
already paid for.

Two files then decide the repair, and both answers are string comparisons
against text ccqa already holds rather than anything the model is asked again:

- **the case's document**, checked in the sweep where its text is in hand.
  What it holds becomes `repair.rewrite`, the edit to make first. Pairs whose
  sides are empty or equal are dropped, as is a `from` the audit answered two
  different ways — dropping every pair for that `from` rather than picking a
  winner, which would invent an answer nobody gave.
- **the saved recording**, checked where the brief already loads it for the
  generation stamp. A recording naming one of the old strings would compile it
  back in, so the case has to be recorded again rather than regenerated.

`repair.route` therefore has four values, each naming what to run:
`regenerate`, `rerecord`, `rewrite` (a live case, whose document is the whole
of it and which is verified by running the case), and `external`. The
generation stamp gates the two that rebuild a generated test, for the reason
it always did; a live case has no such test, so nothing to lose and no stamp
to check.

**A held `from` is a deterministic fact about a file**, which is what makes it
stronger than the axis it can override: it is the evidence available that the
document states the renamed string, which is what `surface` was being asked.

What that fact is not is a claim that every occurrence is stale, and there is
no length floor to make it one. The pairs are therefore one simultaneous
replacement against the document as it stands — a caller must not re-scan text
a replacement wrote, or a chain of pairs would corrupt the file it was meant
to repair. How an occurrence is recognised as the case's UI string at all is
the consumer's: ccqa guarantees the string is in the file, not how that file
delimits one, because the format is the project's.

### Consequences

- Good: the repair a renamed string actually needs is offered to a machine for
  the first time, on the surface where a project that writes its own case
  documents will meet it most often.
- Good: the deciding facts are string comparisons against files, not a model's
  answer about which surface drifted. The weakest link in the old routing was
  the axis; it is now a fallback rather than the gate.
- Good: a caller is never sent to a command that will drive the application
  and then refuse. The `rerecord` answer is reached from the recording, before
  anything is run.
- Good: nothing under `WIRE_CONTRACT_PATHS` moves. The hub neither reads nor
  stores any of this.
- Bad / cost: two more route values for a caller to branch on, and a caller
  that knows only `regenerate` now falls through to its own default on cases
  it used to handle. That is the intended direction — the old value promised a
  repair it could not make — but it is a breaking change to the brief.
- Bad / cost: **a wrong `TEST_DRIFT` can now propose an edit to a document
  that was correct.** Three things bound it and none removes it: the pair must
  survive being looked up in the file; where the case has a generated test,
  that test must be one ccqa wrote and nobody has touched; and the edit must
  arrive as a pull request. A live case has no such stamp gate — the route
  returns before one is reached — so there the verification run and the pull
  request are the whole bound. The model doing the audit is now deciding what
  a reviewer is asked to approve, which raises the cost of auditing with a
  cheap model — already measured in `docs/running.md`, now with a shorter
  path to the same file.
- Bad / cost: the replacement half of a pair is not verified against anything.
  The document check proves `from` is real; `to` rests on the citation, and a
  citation whose file does not hold what the finding quotes is already marked
  `unverified` in the same brief. A reviewer has that signal; the machine does
  not act on it.
- Bad / cost: a listed pair means the string occurs in the document, which is
  weaker than "the document is stale there". A common word, or a short label
  that also reads as ordinary prose, occurs in sentences no rename should
  touch, and deciding which occurrences are the case's UI strings needs the
  document's format — which is the consumer's (ADR-0034). The guarantee stops
  at occurrence.
- Bad / cost: a caller that runs the command without applying `rewrite`
  rebuilds from the same document and sees the finding again. The route names
  the command; only `repair.rewrite` says what to do before it.
- Neutral: both error directions of the recording check are bounded at one
  unnecessary browser run. A miss falls to `regenerate`, whose replay gate
  refuses the dead recording; a substring false positive — an old label that
  is a prefix of a longer recorded one — routes to `rerecord` where
  `regenerate` would have done.
- Watch for: a reply that nests `renames` inside `drift` rather than beside
  it. The diagnosis schema is not strict, so the key is dropped without a
  word and the case silently routes the way it did before this record. That
  is the first thing to check if renames stop arriving.
- Follow-up: the `spec` surface still means two files — the case's document
  and a project-owned file the test imports. The rewrite check separates them
  in practice, since only the document is tested for the string. Naming them
  apart would be a change to an enum shared with the run's failure classifier,
  and is left until something needs it.

### Confirmation

Both checks are pure functions and are tested as such, including a non-ASCII
pair — the case the rejected prose-parsing option could not serve. The routing
is tested separately in `src/drift/brief.test.ts` (now
`src/drift/audit-report.test.ts`), one case per condition in the order they
are read, with the renames passed in directly. The loop itself
was exercised end to end on both repairs: a `rerecord` finding whose document
edit and re-recording left the case green and the next audit clean, and a
`rewrite` finding on a live case verified by running it.

## More information

- Routing: `src/drift/brief.ts` (`buildRepair`; now
  `src/drift/audit-report.ts`)
- The two checks: `auditedRenames` and `recordingNamesRenamed` in
  `src/drift/renames.ts`
- Reply shape: `RenameSchema` and `DriftReplySchema` in `src/drift/types.ts`
- Prompt: `src/prompts/drift.ts` (`DRIFT_PROMPT_VERSION` "12")
- Related: ADR-0030 (the routing this amends), ADR-0028 (the saved recording,
  its replay gate and the generation stamp), ADR-0034 (why ccqa does not make
  the edit itself), ADR-0019 (a machine proposes; a person disposes)
