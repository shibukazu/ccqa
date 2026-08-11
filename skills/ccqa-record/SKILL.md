---
name: ccqa-record
description: >
  Create a new ccqa test case: pin down the behavior to verify, write its
  spec.yaml, choose deterministic or live mode, record it if deterministic,
  and run it until it passes. Use when asked to add, create, or record a new
  ccqa spec/test for a behavior no existing spec covers.
---

# Record a new ccqa test case

You are asked to cover one behavior with a new test case. Finish with a spec
that passes **for the right reason** — assertions that verify the behavior as
the product actually renders it, not whatever happened to be on screen.

## Rules that hold throughout

- **Never edit a generated artefact** — `test.spec.ts`, `ir.json`,
  `generated.json`, anything a target emits. The only file you own is
  `spec.yaml`; everything else changes by re-recording.
- **Follow the neighbors.** Existing specs under `.ccqa/` carry the project's
  conventions — target, login blocks, session names, naming, serial groups.
  Read two or three from the same area before writing anything.
- **Data the test creates is named with `${CCQA_RUN_ID}`** — ccqa sets a fresh
  value per spec per run — and a cleanup step at the end of the spec deletes
  it. A spec that leaves data behind poisons the next run.
- **Keep values out of the spec.** URLs, accounts and secrets stay as `${VAR}`
  references the profile resolves; never inline a concrete value.
- **Do not pass `--report-to-hub`** to a local run. Authoring work must not
  land in the ledger CI reads.

## Before the first command

- **How this project invokes ccqa** — `pnpm exec ccqa`, `npx ccqa`, a
  `package.json` script, or a global `ccqa`.
- **Which `--hub-profile`** — the named bucket of variables and sessions for
  the environment under test.

The project's CI answers both: find where it runs `ccqa run` and copy the
invocation.

## 1. Pin down what to verify

- Check no existing spec already covers it — extending or re-recording an
  existing spec is a different job than adding a duplicate beside it.
- Read the product source for the **concrete observable signals** the flow
  ends in: headings, button labels, element states, URL shapes. The spec's
  `expected` lines are written from the source, never from memory of similar
  products.
- Pick `<feature>/<spec>` following the existing tree's naming.

## 2. Choose the mode

**Deterministic is the default**: recorded once, replayed as generated code,
no model cost at run time. Choose `mode: live` — Claude drives the browser and
judges each step on every run — only when the flow has a property that breaks
replay:

| Signal | Mode |
|---|---|
| Stable screens, addressable elements — forms, lists, CRUD | deterministic |
| Sign-in gated by device-trust / MFA that a fresh browser cannot pass, so the spec needs a saved `session:` — sessions restore in live mode only | live |
| UI hostile to recorded selectors: rich-text or `contenteditable` editors, canvas, heavily timing-dependent rendering | live |
| The expected outcome arrives asynchronously from another actor — a bot reply, a notification — whose timing or wording varies per run | live |
| Every neighboring spec on this surface is live | live — that unanimity is evidence; learn its reason before departing from it |

When in doubt, start deterministic: `mode:` is one line, and a spec that
proves un-replayable in step 5 is switched to live rather than fought. The
reverse migration costs a recording, so it is not the side to err on — but a
live spec bills model time on **every** run, so live is a property of the
flow, never a shortcut around writing addressable steps.

One constraint: `mode:` and `session:` belong to the agent-browser target. If
the area's convention is an external target (e.g. `playwright`) and the table
says live, the spec drops the `target:` line — live runs under agent-browser.

## 3. Write the spec

`.ccqa/features/<feature>/test-cases/<spec>/spec.yaml`: a `title` and `steps`
of `instruction` / `expected` pairs.

- Reuse shared setup through `include` blocks (login is usually one already).
- Every `expected` names something observable — a visible string, a URL
  pattern, an element state — taken from the source you just read. Avoid
  anything that differs between runs: timestamps, exact counts, ids.
- If the spec creates data, its name carries `${CCQA_RUN_ID}` and a final
  step deletes it.
- If the spec writes to a place shared outside the app — a chat channel, a
  shared inbox, a single seeded account — add it to the project's
  `serialGroups` (in `.ccqa/config.yaml`) so parallel runs take turns.
- A live spec that needs a saved session declares `session: <name>` (names
  from neighboring specs). If that session does not exist on the hub yet,
  stop and say which `ccqa hub session capture` a person has to run — do not
  substitute login steps for it.

## 4. Record — deterministic only

A live spec skips this step and step 5: it has no recording, the spec itself
is what runs, and `ccqa record` refuses one.

```sh
ccqa record <feature>/<spec> --hub-profile <profile> --overwrite --auto-fix auto \
  --instruction "<anything the recorder cannot read from the spec alone>"
```

- Every `${VAR}` the spec references must resolve at record time — ccqa warns
  when one is unset, because its concrete trace-time value would bake into
  the test.
- **Run it in the foreground and wait.** A recording takes single-digit
  minutes. If your environment caps how long one command may run, set
  `--timeout` to fit *inside* that cap; on its own timeout ccqa reaps its
  browser session and exits `124`, where a kill from outside leaves the
  browser running. If it truly cannot fit in one command, wait in pieces —
  bounded foreground waits until it exits — and **never end your turn while
  it runs**: a recording that outlives your session is killed halfway, with
  nobody left to read what it found.

## 5. Check the recording before you trust it

A failed trace replaces nothing: its actions go to `ir.failed.json` for
diagnosis, whatever recording existed stays in force, and the command exits
non-zero. On success, confirm the generated test covers **every** step with
`${VAR}` references still symbolic, and heed ccqa's per-step warnings — a
step that recorded no assertion performs without verifying.

On failure, read the per-step results before re-recording — each cause has a
different exit:

- The element exists but resists addressing, the timing never settles, the
  editor swallows recorded input → the **mode table** was answered wrong;
  switch the spec to live and move on.
- The step's premise is false in the product — the string is not there, the
  flow ends elsewhere → **your spec is wrong**; fix `spec.yaml` against the
  source and re-record.
- Something outside the repository — leftover data, a service down, an
  expired session → **stop and report**; recording again cannot repair it.

## 6. Run until green

```sh
ccqa run <feature>/<spec> --hub-profile <profile>
```

A failure is read, not patched: sharpen the spec or the `--instruction` and
re-record (live: fix the spec and re-run). If two attempts fail the same way,
stop and report what you saw — the block is usually one of the three exits in
step 5. When the spec creates data, confirm after the green run that the
cleanup step really removed it.

## 7. Report

The spec path, the chosen mode with its one-sentence justification against
the table, the record and run outcomes, and anything left for a person: a
session to capture, a serial group to review, an environment issue. A stop
with its reason is a complete outcome.
