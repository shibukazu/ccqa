---
name: ccqa-rerecord
description: >
  Bring one ccqa test case back to green after the drift audit flagged it or a
  run failed. Reads the finding from the hub, decides whether the generated
  test, the spec, or neither is what went stale, repairs that, re-records, and
  re-runs. Use when asked to re-record, refresh, repair or fix a ccqa spec
  named <feature>/<spec>.
---

# Re-record a ccqa test case

You are given one test case as `<feature>/<spec>`. Finish with that spec
passing **for the right reason** — not with an assertion weakened until it
stopped complaining.

Do not skip ahead to `ccqa record`. Which repair is correct depends on what the
finding says went stale, and for some findings re-recording is the wrong move
entirely.

## Rules that hold throughout

- **Never edit a generated artefact** — `test.spec.ts`, `ir.json`,
  `generated.json`, anything a target emits. The next `ccqa record` overwrites
  it, so the edit is lost work that also hides the real defect. The only file
  you edit is the spec's `spec.yaml`; everything else changes by re-recording.
- **Never weaken an assertion to make a run pass.** An assertion that matches
  nothing, and therefore always holds, is a defect — usually the very one you
  were sent to fix.
- **Data the test creates is named with `${CCQA_RUN_ID}`** — ccqa sets a fresh
  value per spec per run — and a cleanup step at the end of the spec deletes
  it. A spec that leaves data behind poisons the next run.
- **Keep values out of the spec.** URLs, accounts and secrets stay as `${VAR}`
  references the profile resolves; never inline what one resolved to.
- **Do not pass `--report-to-hub`** to a local run. Repair work must not land in
  the ledger CI reads.
- **A spec with `session:` expects a saved signed-in state.** If it is missing
  or expired, say so and stop — do not add login steps to work around it.

## Before the first command

- **How this project invokes ccqa** — `pnpm exec ccqa`, `npx ccqa`, a
  `package.json` script, or a global `ccqa`.
- **Which `--hub-profile`** — the named bucket of variables and sessions for
  the environment under test.

The project's CI answers both: find where it runs `ccqa run` and copy the
invocation. Guessing a profile name wastes a recording against the wrong
account.

## 1. Read the finding

First confirm `.ccqa/features/<feature>/test-cases/<spec>/spec.yaml` exists: a
ledger entry outlives a spec somebody already deleted. Read it, and note the
two fields that change what you do later — `mode:` and `target:`.

Then get the finding from the hub. The project name is `--project`'s value,
which defaults to the name of the directory holding `.ccqa/`.

```sh
BASE="${CCQA_HUB_URL%/}"   # a trailing slash breaks the request path
AUTH=(-H "Authorization: Bearer $CCQA_HUB_TOKEN")
[ -n "$CCQA_HUB_HEADER" ] && AUTH+=(-H "$CCQA_HUB_HEADER")

curl -sS "${AUTH[@]}" "$BASE/api/v1/projects/<project>/drift"
```

The spec's entry carries `label`, `surface`, `specChangeKind` and the `runId`
of the audit that wrote it. The `headline` is a summary; the part you act on is
in that run's report:

```sh
curl -sS "${AUTH[@]}" "$BASE/api/v1/runs/<runId>/report"
```

The matching row's `analysis` holds `recommendation`, `evidence` (files and
line ranges in the product source) and `reasoning`. **Read the cited source
yourself.** An audit finding is a judgement made by reading code, and you are
about to act on it.

If the last *run* failed, rather than — or as well as — the audit flagging it:

```sh
curl -sS "${AUTH[@]}" "$BASE/api/v1/projects/<project>/rerun?profile=<profile>"
```

`execution: "failed"` carries `lastRed.label` and `lastRed.headline`: the
failure's classified cause. The two axes are independent — a spec can be clean
and failing, or drifted and passing — so read both.

When the hub has no entry for the spec, or its entry predates the change you
are chasing, get a fresh one locally. It reads code only, no browser:

```sh
ccqa audit <feature>/<spec>
```

## 2. Decide what to repair

| Finding | What went stale | What you do |
|---|---|---|
| `TEST_DRIFT`, `surface: generated` | only the compiled test | re-record; leave `spec.yaml` alone |
| `TEST_DRIFT`, `surface: spec` | wording in `spec.yaml` that the test compiled from | fix that wording, then re-record |
| `SPEC_CHANGE`, `BEHAVIOUR_CHANGED` | the behaviour being verified | rewrite the affected steps against the current implementation, then re-record |
| `SPEC_CHANGE`, `FEATURE_REMOVED` | the feature itself | **stop.** Propose deleting the spec, or replacing it with one covering what the feature became. Re-recording cannot verify something the product no longer does |
| `SPEC_CHANGE`, no `specChangeKind` | unclear which of those two | stop and ask |
| `PRODUCT_BUG` | the product | stop. Report the defect — re-recording would encode the bug as the expected result |
| `ENVIRONMENT` | nothing in the repository | stop. Name what is down, missing or expired |
| `UNKNOWN` | the evidence was too weak to call | re-read it yourself; if it stays undetermined, say so rather than guessing |
| No finding at all | nothing is known to be stale | re-record, and check the result against step 5 — the regenerated test has to verify every `expected` in the spec |

Two things to settle before acting on any row:

- **Does the product actually do what the spec says?** If the evidence and the
  source disagree, the finding is the thing that is wrong. Say so instead of
  rewriting a spec to match a mistaken reading.
- **Is the spec `mode: live`?** A live spec has no recording — the spec itself
  is what runs, and `ccqa record` refuses one. Skip steps 4 and 5: repair the
  spec, then run it.

## 3. Rewrite `spec.yaml` — only when step 2 called for it

- Change what the finding names, and nothing else. An unrelated tidy-up in the
  same edit makes the next audit's diff unreadable.
- Every `expected` names something observable in the **current**
  implementation: a visible string, a URL, an element state. Take the string
  from the source you just read; do not carry over the old spec's guess.
- Avoid anything that differs between runs — timestamps, row counts, ids.
- If the spec creates data, its name carries `${CCQA_RUN_ID}` and a final step
  deletes it.

## 4. Re-record

```sh
ccqa record <feature>/<spec> --hub-profile <profile> --overwrite --auto-fix auto \
  --instruction "<what the finding said to fix, in a sentence or two>"
```

- `--overwrite` — an existing test otherwise raises a `y/N` prompt you cannot
  answer.
- `--auto-fix auto` — the default mode prompts, and declines without a
  terminal, so a fixable script failure would end the recording instead.
- `--instruction` — without it the recorder has no reason to do anything
  differently from the recording that drifted.
- `--hub-profile` supplies the `${VAR}` values and the saved sessions, and so
  decides which account the recording drives. Every `${VAR}` the spec
  references must resolve at record time — ccqa warns when one is unset,
  because its concrete trace-time value would bake into the test.

A recording drives a real browser against a real environment, step by step, and
creates whatever the spec creates — which is why the cleanup step matters, and
why it takes minutes rather than seconds.

**Run it in the foreground and wait.** A recording typically takes single-digit
minutes. If your environment caps how long one command may run, set `--timeout`
to fit *inside* that cap — do not copy a longer value from CI and then
background the command to accommodate it. On its own timeout ccqa reaps its
browser session and exits `124`; a kill from outside leaves the browser
running. If the recording truly cannot fit in one command, wait on it in
pieces — start it, then keep issuing bounded foreground waits until it exits,
rather than counting on a wake-up that may never come — and **never end your
turn while it runs**: a recording that outlives your session is killed halfway,
with nobody left to read what it found.

## 5. Check the recording before you trust it

A failed trace replaces nothing: its actions go to `ir.failed.json` for
diagnosis, the previous recording and test stay in force, and the command
exits non-zero. So read the outcome, then act on which it was:

- **On success**, confirm the regenerated test still covers **every** step of
  the spec, with the finding's assertion now checking something real. Heed
  ccqa's per-step warnings — a step that recorded no assertion performs
  without verifying, the kind of green that reads as coverage.
- **On failure**, read the per-step results before re-recording. A step that
  fails for a reason outside the repository — leftover data from earlier
  runs, a service that is down, an expired session — is not repaired by
  recording again: report it and stop. That is the honest outcome.

## 6. Run it

```sh
ccqa run <feature>/<spec> --hub-profile <profile>
```

Passing is the goal, but only alongside the check above. If it fails, read the
failure — never patch the generated file. Re-record once more with a sharper
`--instruction`. If the second attempt fails the same way, the finding was
probably not `TEST_DRIFT`: stop, say what you saw, and hand it back.

## 7. Report

Briefly: the finding you acted on, which row of step 2 you took, what changed
in `spec.yaml` (if anything), and the run's result. If you stopped — at step 2
or at step 5 — the reason **is** the answer. That is a complete outcome, not a
failure to finish.
