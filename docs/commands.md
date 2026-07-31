# Command and environment reference

An index, not a manual: every command ccqa ships, one line each, with a
pointer to the document that explains it. `ccqa <command> --help` is
authoritative for flags.

## Authoring

| Command | What it does |
|---|---|
| `ccqa init` | Create the `.ccqa/` skeleton (`features/`, `blocks/`). |
| `ccqa draft [feature/spec]` | Draft or refine a `spec.yaml` interactively with Claude. See [Draft](./draft.md). |
| `ccqa record <feature/spec>` | Drive the browser once and compile the recording into test code. Use `--auto-fix auto` in CI, where nobody can answer a prompt. See [Auto-fix](./auto-fix.md). |
| `ccqa generate <feature/spec>` | Re-emit test code from an existing recording, or straight from the spec for spec-input targets like `runn`. See [Generation targets](./targets.md). |
| `ccqa perspectives` | Rebuild the project's coverage inventory on the hub. See [spec.yaml reference](./spec.md#inventory-coverage-with-perspectives). |

## Running

| Command | What it does |
|---|---|
| `ccqa run [feature/spec…]` | Replay specs and write a report. See [Running specs](./running.md#ccqa-run). |
| `ccqa run --only-affected-by <ref>` | Replay only the specs the diff against `<ref>` reaches. See [Scoping with `--only-affected-by`](./running.md#scoping-with---only-affected-by). |
| `ccqa run --only-hub-rerun-needed` | Replay only the specs the hub answers `rerunNeeded` for: cleared by the audit, and out of date. A spec the audit rejected, or whose last run failed, answers `needsRepair` and is never taken. See [Running only what needs a re-run](./running.md#running-only-what-needs-a-re-run). |
| `ccqa run --on-fail-explain` | Give every failing spec a root-cause label and a drift audit. See [Failure triage](./running.md#failure-triage). |
| `ccqa audit [feature/spec]` | Audit specs against the codebase without running a browser. See [Drift detection](./running.md#drift-detection). |
| `ccqa audit --only-hub-audit-needed` | Audit only the specs a deploy has reached since the audit last read them, plus every spec never audited. See [Auditing only what the deploy reached](./running.md#auditing-only-what-the-deploy-reached). |
| `ccqa select-specs --base <ref>` | Answer which specs a range reaches, and nothing else — the machinery behind `--only-affected-by`, usable on its own. See [Asking the question on its own](./running.md#asking-the-question-on-its-own). |

Both `run` and `audit` accept `--report-format github` to annotate a pull request.
`run` also takes `--dry-run`, which prints the selection and stops — worth a
look before letting a selection decide what a paid run covers.

## Sessions

| Command | What it does |
|---|---|
| `ccqa hub session capture <name>` | Open a headed browser, log in by hand, and save the result — the only way to get a signed-in session into CI. See [Saved sessions](./sessions.md). |
| `ccqa hub session push / ls / rm` | Move saved sessions to and from the hub. |

## Hub

| Command | What it does |
|---|---|
| `ccqa serve` | Start the hub. See [Hub](./hub.md#starting-a-hub). |
| `ccqa hub push --report-dir <dir>` | Upload a finished report. Prefer `ccqa run --report-to-hub`, which streams as the run executes. See [`ccqa hub push`](./hub.md#ccqa-hub-push). |
| `ccqa hub var set / ls / rm` | Manage the variables `${…}` in a spec resolve to at run time. See [Sharing sessions and variables](./hub.md#sharing-sessions-and-variables-via-the-hub). |
| `ccqa hub deploy record --profile <p> --sha <sha>` | Tell the hub what a deploy shipped, and which specs it reaches. `--no-select-specs` skips the second half, leaving a hole `--only-hub-rerun-needed` can only answer `unanswerable`. See [`ccqa hub deploy record`](./hub.md#ccqa-hub-deploy-record). |
| `ccqa hub prompt push / ls / rm` | Manage per-flow guidance and learned prompts. See [Triage learning](./hub.md#triage-learning). |

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `CCQA_HUB_URL` | every client command | Same as `--hub-url`. |
| `CCQA_HUB_TOKEN` | every client command, `ccqa serve` | Same as `--hub-token`. The hub refuses to start without it. |
| `CCQA_HUB_HEADER` | every client command | One extra header as `name:value`, for a hub behind an authenticating proxy. Repeatable as `--hub-header`. |
| `CCQA_HUB_ENCRYPTION_KEY` | `ccqa serve` | 64 hex characters. Optional, but without it the hub returns 503 for session and variable writes — they are never stored in the clear. See [Encryption](./hub.md#encryption). |
| `CCQA_MODEL` | anything that calls Claude | Default model. Same as `-m/--model`. |
| `ANTHROPIC_API_KEY` | anything that calls Claude | One of the accepted credentials, alongside `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` and a local `claude` login. In CI there is nothing to log into, so one of these must be set. |

Which commands call Claude, and therefore need a credential: `draft`,
`perspectives`, `record`, `audit`, `select-specs`, `run` on a `mode: live`
spec, and `run --on-fail-explain`. A deterministic `ccqa run` calls no
model at all.
