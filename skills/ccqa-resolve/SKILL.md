---
name: ccqa-resolve
description: >
  Clear the ccqa rows that are waiting on a person: read the hub's verdict for
  a project, drop what is already in hand, and route each remaining row to the
  repair it actually needs — a product fix, a re-recording, an environment
  repair — heaviest first. Use when asked to triage, resolve or work through
  ccqa findings, a release verdict, or "what needs attention".
---

# Resolve what ccqa is holding for a person

You are asked to clear what a project's ccqa hub says a person has to handle.
Finish with every row either repaired or stopped at a stated reason.

**The hub's verdict is the input.** If you were handed a notification, use it
to find which project and profile to ask about — then work from what the hub
answers now, not from the message.

## Rules that hold throughout

- **Never weaken a test to clear a row.** Loosening an assertion or dropping a
  step turns a row green by destroying what made it worth reading.
- **Never edit a generated artefact** — `test.spec.ts`, `ir.json`,
  `generated.json`, anything a target emits. A test that no longer fits the
  product is repaired by re-recording it, never by hand.
- **Attesting and dismissing are a person's word, and each answers one thing.**
  `ccqa hub attest <feature>/<spec> --profile <profile> --by <name>` answers an
  `ENVIRONMENT` failure: somebody fixed the environment and checked the
  behaviour by hand. `ccqa hub dismiss <feature>/<spec> --by <name> --reason
  <text>` answers an audit finding that is wrong. Nothing answers a
  `TEST_DRIFT` or `PRODUCT_BUG` row — those are repaired, not overruled, and
  the CLI will not stop you getting that wrong. Hand a person the command with
  your reasoning; do not run it yourself, and never offer an attestation for a
  row your own run cleared, which would put a person's word behind a machine
  result.
- **A run reaches the ledger only if it observed, not repaired.** The ledger
  merges every branch, newest wins, so a push speaks for the whole project:
  push only when the spec that ran is the one that is merged. Confirm that —
  `git diff <base> -- <the spec's directory>` comes back empty — because a
  pass recorded for code nobody shipped overwrites the verdict everyone reads.
  Repairing an environment changes no files, so its confirming run qualifies,
  and pushing it is what clears the row: nothing else does.
- **Run every `ccqa run` in the foreground and wait.** It drives a real browser
  and takes minutes. If your environment caps how long one command may run, do
  not background it and move on; start it, then keep issuing bounded foreground
  waits until it exits. A run nobody is waiting on is killed halfway, with
  nobody left to read what it found.
- **One row at a time.** Two repairs in one change cannot be reviewed or
  reverted apart.

## Before the first command

- **How this project invokes ccqa** — `pnpm exec ccqa`, `npx ccqa`, a
  `package.json` script, or a global `ccqa`.
- **The `--project` and `--hub-profile`** — the hub project holding the
  verdict, and the named bucket of variables and sessions for the environment
  it was reached against. `--project` defaults to the name of the directory
  holding `.ccqa/`; pass it explicitly when the hub project is named otherwise.
- **A hub connection** — `CCQA_HUB_URL` and `CCQA_HUB_TOKEN`, plus
  `CCQA_HUB_HEADER` where a proxy in front of the hub needs one.

The project's CI answers the first two: find where it runs `ccqa run` and copy
the invocation.

## 1. Ask the hub what needs a person

```sh
BASE="${CCQA_HUB_URL%/}"   # a trailing slash breaks the request path
AUTH=(-H "Authorization: Bearer $CCQA_HUB_TOKEN")
[ -n "$CCQA_HUB_HEADER" ] && AUTH+=(-H "$CCQA_HUB_HEADER")

curl -sS "${AUTH[@]}" "$BASE/api/v1/projects/<project>/rerun?profile=<profile>"
```

`specs` carries one entry per spec, and exactly one `verdict` asks for a
person:

| `verdict` | Who acts next |
|---|---|
| `needsRepair` | **you** |
| `inProgress` | nobody — an audit or a run is in flight, or the audit has not caught up with the last deploy |
| `rerunNeeded` | the next run that takes `--only-hub-rerun-needed` |
| `verified` | nobody |
| `manuallyVerified` | nobody — a person's attestation stands until it lapses |

Your work list is the `needsRepair` rows. Nothing else on the list is yours to
touch, however red it looks.

## 2. Before you start a row

- **A repair may already be open.** Check the project's review queue for a
  change already repairing this spec — some projects open them automatically.
  A second repair on top produces two changes for one row: leave it, and name
  it in your report.
- **The finding may have been argued before.** `auditDismissed` present with
  `auditDismissalApplied: false` means a person judged an earlier finding on
  this spec wrong and a later audit raised one anyway. Read their `note`
  first; if your reasoning only repeats theirs, report that rather than
  repairing.

## 3. Route each row

Each row ships the two axes it was derived from: `audit`, what a static read
of the repository concluded, and `execution`, how the last run ended. On a
`needsRepair` row the repair follows from `audit` first and, when the audit is
clean, from what the failed run concluded in `lastRed.label`.

| Row | What it means | Go to |
|---|---|---|
| `audit: "clean"`, `lastRed.label: "PRODUCT_BUG"` | the audit ruled the test out as the cause and it failed anyway — the only row that is evidence about the product | step 5 |
| `audit: "drifted"` or `audit: "undecided"` | the spec no longer describes the code, so it is not a valid check; nothing is known about the behaviour it covers | step 6 |
| `audit: "clean"`, `lastRed.label` is `TEST_DRIFT` or `SPEC_CHANGE` | the run found staleness the audit missed — same repair, and worth naming in your report so the audit can be corrected | step 6 |
| `audit: "clean"`, `lastRed.label` is `UNKNOWN` or `ENVIRONMENT` | neither label claims the failure reproduces | step 4 |
| `audit: "clean"`, no `lastRed.label` | failure analysis is opt-in, so nothing is on record | classify it from the run report, then take the row above that fits |

Work them in that order — a product defect outranks any number of stale specs,
whatever the counts look like.

## 4. Re-run `UNKNOWN` and `ENVIRONMENT` first

Neither label claims anything is still broken: one says the classifier could
not tie the failure to a change, the other that the test never got to run. It
is the same line `ccqa run --on-fail-explain-rerun auto` draws. Run the spec
once and let it decide:

```sh
ccqa run <feature>/<spec> --hub-profile <profile>
```

- **It passes.** Read *how* before calling the row healthy. A live spec's
  agent improvises, so it can work around a broken environment and still
  finish. Treat any of these in the step records as a workaround: a screen the
  spec never mentions appeared on the way through; a step needed a reload, a
  retry or a second navigation to settle; the agent did something the spec does
  not ask for, to get past a blocker. One is enough — quote it, treat the
  environment as still broken, and go to step 7. The next run pays the same
  cost, and one day improvises wrong. If none of them appear, the run is a
  clean observation of an environment that works — push it with `ccqa hub
  push` (step 7) and the row clears without waiting for CI.
- **It fails again.** Now you have a reproduction: take `ENVIRONMENT` to step
  7, and `UNKNOWN` to step 6 once you have read the run report.

Repairing either without re-running first means repairing a spec that was
never broken.

## 5. A defect in the product

`lastRed.runId` names the run that failed:

```sh
curl -sS "${AUTH[@]}" "$BASE/api/v1/runs/<runId>/report"
```

The row for the spec holds two things worth keeping apart. `analysis` is the
classifier's opinion — `recommendation`, `evidence` (files and line ranges),
`reasoning`. `failureLogExcerpt` is what actually happened: the failing step,
its expectation, and the log the agent left behind. When the two disagree the
log wins; it is an observation, and the analysis is a guess about it.

**Check the label before acting on it.** It fails in two directions worth
catching: the step may have failed for a reason outside the product (step 7),
or the spec may assert something the product never promised, which makes the
spec the thing that is wrong (step 6). Read the cited source yourself and say
which.

Once it holds, fix the **product**, and open a pull request following the
repository's conventions. Then stop short of calling the row closed: it stands
until the fix reaches the environment and the spec runs against it. The pull
request is the outcome.

## 6. The spec no longer describes the code

**Follow the `ccqa-rerecord` skill, one spec at a time.** It decides which
surface went stale — the compiled test, the spec's wording, or a feature that
is gone — and what repairs each. Do not re-derive that decision here.

Hand it what you already know, or it repeats your work and can reach a
different answer: the spec id, the project and profile, and — for a row routed
here by a run's label rather than by the audit — that label and
`lastRed.runId`. The drift ledger reads clean for those rows, so the finding
it would otherwise look for is not there.

It may come back naming a different cause: the product regressed, or something
outside the repository blocked the run. That is a re-route, not an answer —
carry the row to step 5 or step 7 and finish it there, rather than reporting
the hand-off and stopping.

If it concludes the finding itself is mistaken — the spec describes the code
correctly — do not rewrite the spec to match a misreading. Where the audit
raised it, `ccqa hub dismiss` is what records the correction: report the
command with the reason, for a person to run. Where a run's label raised it
the audit reads clean, so there is no open finding and the hub refuses a
dismissal; there the report is the whole correction.

## 7. The environment, not the test

You arrive here having seen it for yourself: step 4's re-run either failed
again, or passed only by working around something. Name the blocker from the
run report before touching anything — `ENVIRONMENT` is a category, not a
cause.

Repair what is yours:

- **Data an earlier run left behind.** A spec names what it creates with
  `${CCQA_RUN_ID}` and deletes it in a cleanup step; a run that died halfway
  never got there. Remove the leftovers the way the product does — through its
  own interface, not by reaching into a datastore behind it.
- **A variable pointing at something that moved** — `ccqa hub var set <NAME>
  --value <value> --profile <profile>`. Every spec in the profile reads it, so
  confirm the new value against the environment before writing, and name the
  change in your report.

Then let a run answer: `ccqa run <feature>/<spec> --hub-profile <profile>`. An
environment repair is claimed only when a run passes — and once it does, push
that run, because the row moves on the result and nothing else:

```sh
ccqa hub push --project <project> --profile <profile>
```

Stop — with the command a person needs — for anything that needs a human at
a keyboard:

- **A saved session that expired, or that no longer restores.** `ccqa hub
  session capture <name> --url <a page only reachable once signed in>
  --profile <profile>` opens a headed browser to log in by hand. Pass that
  `--url`: capture verifies the state restores to it and stores it as the
  anchor each run re-checks, and a session saved without one is never
  health-checked at all. **Never add login steps to a spec to route around
  a missing session.**
- A service that is down, an account that does not exist, a permission that was
  never granted. Name it and stop.

Whatever the person fixes, their fix is not the outcome. A captured session
says the login worked; it says nothing about whether the spec runs. When the
fix lands, come back and take the run above — the row closes on a spec that
passes against the repaired environment and gets pushed, and on nothing else.

## 8. Report

One line per row: what you judged it to be and which axes decided that, what
you did, and how it ended. Then, separately, what is left for a person — a
pull request to review, a session to capture, a dismissal for a finding you
showed to be wrong — each with the command and the reasoning you would give
for it.

A row you stopped at is a complete outcome; the reason **is** the answer.
