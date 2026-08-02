# 0012. Flag names carry their group, and one flag means one thing

- Status: accepted
- Date: 2026-07-28

## Context and problem statement

The CLI grew a flag at a time, and the surface stopped being readable.
`ccqa run` had 18 options and `ccqa drift` 11, listed flat, with no way to
tell from a name what a flag does or where it applies.

Three specific failures had accumulated.

**One flag carrying two mechanisms.** `--changed [base]` took either a git
ref — resolved by diffing and asking `ccqa select-specs` — or the literal
string `last-run`, which read per-spec verdicts off the hub and did no git
work at all. The two need different inputs (one needs a hub connection and
`--hub-profile`), fail differently, and share only the word "changed". Worse,
they could not be combined: the selection CI actually wants is "reached by
this diff **and** audited clean", which a single value cannot express.

**One flag carrying two roles.** `--failure-analysis [base]` was both the
switch that turned classification on and the way to name its baseline.

**Names that describe neither the action nor its scope.** `--changed` did not
say that what changed was the product code, nor that the effect is to narrow
the spec set. `--report [dir]` read as "produce a report" when a report is
always written and only its location is configurable. `--retry` was a *step*
retry that only applied to live specs, sitting next to flags that applied to
replay specs, distinguishable only by a parenthetical in the help text.
`--include-unknown` silently did nothing unless `--changed=last-run` was also
passed. `--update-agent-prompt` existed on three commands and refreshed a
different prompt on each.

## Considered options

- **Rename for consistency only.** Align `drift --changed --base X` with
  `run --changed X`, `--push-report` with `--push`, and keep aliases. Cheap
  and non-breaking, but leaves the overloaded flags overloaded — the part
  that actually makes the surface unreadable.
- **Split into subcommands** (`ccqa run changed <ref>`, `ccqa run pending`).
  Shortest help output, and mode-specific options appear only under their
  own subcommand. But selection stops composing: "reached by this diff and
  audited clean" cannot be written at all.
- **One flag per condition, grouped by prefix.** Chosen.

## Decision

**A flag name states what it does and what it applies to, and its prefix
names its group.** Five prefixes: `--only-` narrows the spec set, `--on-fail-`
runs after a failure, `--report-` concerns the results, `--live-` / `--replay-`
apply to one execution mode, `--learn-` writes a prompt back to the hub.

**Selection filters compose.** Every `--only-*` narrows what the previous one
left, so passing several ANDs them:

```
ccqa run --only-affected-by origin/main --only-hub-rerun-needed
```

Each is one condition, so the combination needs no new vocabulary.

*(The two flags this example first used, `--only-hub-audited-clean` and
`--only-hub-stale`, are gone. 1.15 folded the audit's answer into the re-run
verdict, so one flag says "worth running" — see
[ADR-0014](0014-two-axes-one-verdict.md). The naming rules below are unchanged;
only the names they are demonstrated on have moved.)*

**A flag that reads or writes the hub says so in its name**, and fails when it
cannot reach one. `--only-hub-rerun-needed`, `--only-hub-audit-needed`,
`--learn-hub-live-prompt`, `--report-to-hub`, `--hub-profile`: from the name
alone you can tell which invocations need a hub running. None of them degrade
— asking for hub-backed selection and silently getting an unfiltered run, or
asking to publish and silently not publishing, are the failures worth being
loud about. Prompt fetching follows the same rule without a flag: a prompt
that was never stored is null, but a hub that cannot be reached stops the run,
because guidance the project configured and ccqa could not read would change
what Claude does with nobody told.

**Groups appear in `--help` too**, via commander 14's `.optionsGroup()` and
`.commandsGroup()`. The prefix tells you the group from the name alone; the
help confirms it.

`drift` is renamed to `audit`. Every other command is a verb; `drift` was a
noun, and the name of a *result* rather than the act of looking for it.

Old names are not kept as aliases. The tool has few users today, and carrying
both spellings would put the thing this ADR is fixing — two names for one
idea — back into the help output.

## Consequences

**Good.** A reader can place a flag without the help text. Flags that used to
be silently ignored outside their mode now say so in their names, so
`--live-step-retry` on a replay spec is visibly wrong rather than quietly
inert. Removing the keyword values (`last-run`, `last-green`) deleted the code
that had to reject each keyword on the flag it did not belong to.

**Bad / cost.** Every caller breaks: CI workflows, scripts, and the
documentation all need updating in step. `--only-affected-by <ref>` now
requires an explicit ref, so a pull-request workflow passes
`$GITHUB_BASE_REF` itself instead of relying on the flag to read the
environment — more typing, in exchange for no hidden inputs.

**Deferred.** `--on-fail-explain-rerun`, which would rerun a failed spec to
separate an unstable one from a real failure, is not part of this change. It
needs somewhere in the report to say "unstable", and that belongs with the
rework of the failure labels themselves.

*(Delivered since, once [ADR-0016](0016-one-vocabulary-two-answerable-subsets.md)
settled where a rerun's answer lands: a second attempt that passes earns
`ENVIRONMENT`. The name is as deferred here, with
`--on-fail-explain-rerun-max-specs` beside it — the prefix rules above are why
the cap is spelled that way rather than `--max-reruns`.)*
