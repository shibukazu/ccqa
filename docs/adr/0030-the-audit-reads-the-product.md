# 0030. The audit reads the product, and may name it

- Status: accepted
- Date: 2026-09-11

## Context and problem statement

`ccqa audit` answers one question: does this test case still describe the
product? It reads the case's document, the generated test, and "the source" —
which until now meant whatever sits under the working directory.

That definition held only while the tests and the application were the same
checkout. They often are not. A team that keeps its end-to-end tests in their
own repository, and points ccqa at that repository, gives the audit a working
directory containing tests, page objects and fixtures — and no product at all.
Every finding it can reach is then a claim about the test reading itself. The
audit still returns "no drift", confidently, having had nothing to be right
about.

Two smaller problems travel with the same input contract:

- **The case's document is not always ccqa's.** ADR-0029 let a project write
  its cases as its own markdown. The audit still read `spec.yaml`, so those
  cases were invisible to it: the one surface that states intent was the one
  it could not open.
- **The audit could not say what it had found.** ADR-0016 gave the audit two
  of the four failure causes, on the reasoning that a static read cannot
  observe a product regression. It then recorded a measured case where the
  audit answered `SPEC_CHANGE` at 95% confidence while its own recommendation
  said "fix the helper, then re-record the test" — a label contradicting its
  own advice, because the honest label was forbidden.

## Considered options

- **Leave the audit inside the working directory.** Ask the project to check
  the application out beside its tests and pass `--cwd` at their common root.
  This works only when one repository contains both, changes what every other
  ccqa command means by "the project", and pulls an unrelated tree into the
  import walk and the coverage root.
- **Name the product's source in config, and widen what the audit may
  conclude.** The project says where the application is; the audit's tools
  reach there; and the four-cause vocabulary is available to it, with only the
  two causes it can act on holding the gate shut.
- **Widen the vocabulary without giving the audit the source.** Strictly
  worse: it would let the audit guess at a product bug with less to read than
  it has today, which is the failure mode ADR-0016 refused.

## Decision outcome

Chosen: **name the product's source, and widen what the audit may conclude.**

### `sourceRoots` says where the product is

A root-level `sourceRoots: string[]` in `.ccqa/config.yaml` names directories
holding the application's own source. They may be absolute and they may be
outside the project — that is the case this exists for. They are resolved to
real paths (symlinks followed) before the audit runs, because search tools do
not follow symlinks and a root reached through one would read as empty rather
than as wrong. A root that is not a directory is an error: an audit that
silently reads nothing reports no drift, which is indistinguishable from a
clean sweep.

The roots widen what the model's `Read` and `Grep` may reach, and are named to
it as directories. Nothing describes what is in them — that is the audit's to
find, and describing it would put one project's vocabulary into every
project's prompt (ADR-0029).

### The intent is whichever document the project writes

The audit's first surface is no longer "spec.yaml" but "the document that
states this case", read verbatim, with the prompt's own vocabulary following
it. Enumeration follows the same rule `ccqa generate` already uses: a target
that declares an `intent` source has its cases read from the project's own
directory, and one that does not has them read from `.ccqa/features/`.

A markdown case is handed over whole, headings included. The headings a team
writes under are part of what its author meant, and ccqa's field map exists to
find sections, not to decide which of them matter.

### All four causes, but only two of them gate

`ccqa audit` may now answer `PRODUCT_BUG` and `ENVIRONMENT` as well as
`TEST_DRIFT` and `SPEC_CHANGE`. This amends ADR-0016's "two answerable
subsets", and the thing that changed is the evidence available: with
`sourceRoots` the audit can read the code the case is about, which is what its
exclusion rested on not being true.

What keeps this from being the unearned label ADR-0016 refused is that the two
new answers do not act:

- `TEST_DRIFT` and `SPEC_CHANGE` name a repair a reader can make from what the
  audit read, and they fail `--exit-on error` — the case does not run until
  someone fixes it.
- `PRODUCT_BUG` and `ENVIRONMENT` are reported at warn severity. The case
  still runs, because running it is what settles them, and the run's own
  classifier decides with the execution evidence in hand (ADR-0016's one
  call). The audit's job there is to say what it saw, early, not to hold the
  gate on a suspicion.

The hub's cycle gate follows the same split, and has to. The verdict behind
`--only-hub-rerun-needed` reads a spec's newest audit entry, and treating any
finding as "drifted" would let a suspected product bug stop the one thing
that would demonstrate it. Both new labels leave the audit axis `clean`
there — which is literally what they say, since each of them read the test
case and found it faithful before naming something else. `UNKNOWN` is unchanged: it says the
audit could not read the case, which is not the same as clearing it.

Both still need a citation, and `PRODUCT_BUG` needs one that contradicts the
intent — a branch that returns before the effect the case expects, a call
deleted while everything around it still promises the result. "I suspect a
regression" remains `UNKNOWN`.

### Routing is not evidence

`ccqa audit --brief <dir>` writes one JSON file per finding for whatever
repairs the test. It marks each case `regenerate` or `external`, answering the
one question a fix job has: may I regenerate this test?

`regenerate` takes two things, and both are about the repair rather than about
the finding's importance. The finding has to be one a regeneration could fix —
`TEST_DRIFT` on the `generated` surface, the surface a regeneration rewrites;
a stale document or a changed behaviour recompiles to the same stale test. And
the generation stamp on the recording (ADR-0028) has to match, so nobody's
edits are discarded.

Only that second half reads the stamp, and only for the route. The verdict
above it never does. Who owns a file is not evidence about whether it still
matches the product, and an audit that read ownership into its finding would
be answering a different question than the one it was asked.

## Consequences

- Good: a project whose tests and application are separate checkouts can be
  audited at all. This was the blocking gap, and no other option closed it.
- Good: the case's own document is the audit's first surface whichever kind it
  is, so a project that writes markdown gets the same audit as one that writes
  `spec.yaml` — one code path, not two.
- Good: the label the audit reaches for is no longer bounded below the
  evidence it holds, which removes the "label contradicts its own
  recommendation" failure ADR-0016 measured.
- Bad / cost: **the audit can now be wrong in a new direction.** A false
  `PRODUCT_BUG` sends someone to read product code that is fine. The warn
  severity bounds the damage — nothing is blocked — but the claim is still in
  the report, and grading it is how a project finds out whether the prompt
  earns it. `causesForKind("drift")` widened to match, so a human can record
  that ground truth.
- Bad / cost: the audit reads outside the project. `sourceRoots` is the only
  thing that widens it, it is opt-in, and it grants read access and nothing
  else — but a project pointing it at a large tree pays for that in what the
  model searches.
- Bad / cost: **the hub moves with the CLI.** No enum gained a member —
  `PRODUCT_BUG` and `ENVIRONMENT` were already in `PREDICTED_LABELS` for run
  rows — but a drift row may now carry one, and a hub built against the
  narrower drift set would reject it. The release is major, so the two move
  together; deploy the hub first, as ADR-0016 required for the same reason.
- Neutral: a project with no `sourceRoots` gets exactly today's behaviour. The
  field defaults to empty and the audit then reads the working directory
  alone, as it always did.

## More information

- Config and resolution: `src/config/source-roots.ts`, `sourceRoots` in
  `src/config/project-config.ts`
- Audit input: `src/drift/artifacts.ts` (`collectCaseArtifacts`), prompt in
  `src/prompts/drift.ts` (`DRIFT_PROMPT_VERSION` "8")
- Severity split: `driftSeverity` in `src/drift/types.ts`
- Briefs: `src/drift/brief.ts`
- Related: ADR-0016 (the audit's answerable subset, widened here), ADR-0028
  (the derived test path and the generation stamp the briefs route on),
  ADR-0029 (mechanism in ccqa, facts in the project's config)
