# 0028. The test path is derived; the recording is the route

- Status: accepted
- Date: 2026-09-10

## Context and problem statement

Two files describe a generated test case today, and neither is the code.

`generated.json` is a manifest `ccqa generate` writes into the spec directory:
which files it wrote, with a `sha256` each. `ccqa run` reads it to learn what
to hand the target's `runCommand`; the drift audit reads it to learn what to
audit; failure triage reads it for the sources; perspectives reads its mere
existence to answer "is this spec generated". Nothing else can answer those
questions, because the generation pass is free to put the test anywhere under
`outDir` — an LLM rewrite may relocate it to match repo conventions.

That makes the manifest a second source of truth about a fact the filesystem
already holds, and it goes stale in the ordinary course of work. Move the test
in the consumer's repo and every ccqa command loses it. Delete the manifest —
it is a build artifact in a directory people clean — and a generated spec reads
as ungenerated. Commit the manifest and its `sha256` fields turn every edit
into a diff nobody asked for. The consumer also has to accept ccqa's bookkeeping
into their tree to run a test they own.

The `sha256` half is the only thing that could notice a hand-edited test, and
it is also the reason the manifest cannot simply be deleted without deciding
what replaces it.

Meanwhile `ir.json` — the recorded route — is treated as a private input to
codegen. It is the only artifact that says how the test came to exist, and
nothing reads it after generation.

## Considered options

- **Keep the manifest, harden it.** Commit it, validate it on read, warn when
  it disagrees with the tree. Every fix adds bookkeeping to the consumer's repo
  and none of them make it true.
- **Derive the test path from config.** The project declares a `testPath`
  template; every command expands it. The manifest disappears because the
  question it answered is now answerable without it.
- **Search for the test.** Glob the repo for something that looks like this
  spec's test. Cheap to describe, unbounded to specify, and wrong silently.

## Decision outcome

Chosen option: **derive the path**, and give the recording a job after
generation.

`targets.<name>.testPath` is a template over `{feature}` and `{spec}` —
`e2e/specs/{feature}/{spec}.spec.ts` — defaulting to the spec's own directory,
which is where generated tests already landed. `ccqa run`, the audit, triage
and perspectives all expand it. Generation is held to it: the
output contract names the one path the test may take, and a rewrite pass that
answers with another is rejected and asked again. Support files stay free —
they belong to the repo's layout, and a page object's home is the repo's
business, not ccqa's.

The code a test leans on is found the way the code itself finds it: by
following the test's imports, resolving relative specifiers and the project's
`tsconfig.json` `paths` aliases, to a bounded depth, never into
`node_modules`. That set cannot go stale, because it is what actually runs.

Nothing replaces the hash: **ccqa stops claiming to know whether a test was
hand-edited.** The question needs a record of what the last generation wrote,
which is the manifest itself. The two facts left — the test's and the
recording's timestamps — cannot answer it, because `ccqa generate` rewrites
the test and never touches the recording: after one regeneration is committed,
"the test moved last" is true of every spec, and a gate reading it would refuse
the very workflow this ADR exists to enable. `ccqa generate` therefore asks
before replacing an existing test (`--overwrite` skips the prompt), which is
what it did before this change, and says plainly that it cannot tell whose
edit it is about to lose.

`ir.json` becomes the **record of the route**: the operations, locators, values
and checks a recording actually performed, plus the minimum provenance
(`recordedAt`, and the entry point with `${VAR}` refs intact). It is read three
times after generation:

- to **regenerate without a browser** when a page object or a convention
  changes — the reason `ccqa generate` exists apart from `ccqa record`;
- to **diff routes** on a re-record, per spec step, so a reviewer sees what
  moved instead of two JSON files;
- to **date the test's origin**.

Regeneration from a saved route is guarded, because its premise can expire. If
the recorded route no longer replays against the application, re-emitting it
can only produce a test that cannot pass: refused, with `--no-replay` for the
environments that have no browser or no variables. The replay uses the
post-trace validator — no model, no cost beyond the browser.

A refusal, not a warning. A warning about a file is read after the file is
gone.

Consequences:

- **A hand-edited test is protected by a prompt, not by a check.** `ccqa run`
  no longer warns that a generated file drifted from what generate produced —
  that warning was the manifest's hash. A project that wants generated code
  guarded keeps it in review, the way it guards any other file.
- **The consumer's tree holds one ccqa artifact per spec**, the route. The
  generated test and its support files belong to the consumer, and ccqa keeps
  no ledger about them.
- **Every command agrees on where the test is, before it exists.** "Not
  generated yet" and "generated" are the same question asked of the same path,
  which is what lets `ccqa run` say `run 'ccqa generate' first` rather than
  losing the spec.
- **A generation pass can no longer choose the test's location.** That is a
  loss of flexibility, deliberately: the location is the project's decision,
  and a path chosen per run is a path nothing can find twice.
- **Breaking, with no migration.** `outDir` is not read; `generated.json` is
  not read and not written. A project on an external target sets `testPath` (or
  accepts the spec-directory default) and deletes the manifests. Recordings
  written before the envelope still generate — a bare action array is read as a
  route with no provenance.
- **The audit reads more, and says what it did not read.** Following imports
  pulls page objects into the audit, so its byte budget is spent on more files;
  what does not fit is named as unaudited rather than silently cut, because a
  file the audit never saw must not read as one it cleared.
