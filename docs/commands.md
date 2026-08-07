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
| `ccqa record <feature/spec> --report-to-hub` | Leave a `kind: record` run on the hub saying the spec was recorded and what that spent, so a budget summed over the hub's runs counts it. It advances no ledger. See [What leaves a run on the hub](./running.md#what-leaves-a-run-on-the-hub). |
| `ccqa generate <feature/spec>` | Re-emit test code from an existing recording, or straight from the spec for spec-input targets like `runn`. See [Generation targets](./targets.md). |
| `ccqa perspectives` | Rebuild the project's coverage inventory on the hub. See [spec.yaml reference](./spec.md#inventory-coverage-with-perspectives). |

## Running

| Command | What it does |
|---|---|
| `ccqa run [feature/spec…]` | Replay specs and write a report. See [Running specs](./running.md#ccqa-run). |
| `ccqa run --only-affected-by <ref>` | Replay only the specs the diff against `<ref>` reaches. See [Scoping with `--only-affected-by`](./running.md#scoping-with---only-affected-by). |
| `ccqa run --only-hub-rerun-needed` | Replay only the specs the hub answers `rerunNeeded` for: cleared by the audit, and out of date. A spec the audit rejected, or whose last run failed, answers `needsRepair` and is never taken. See [Running only what needs a re-run](./running.md#running-only-what-needs-a-re-run). |
| `ccqa run --on-fail-explain` | Give every failing spec a root-cause label across all four causes, in one call. See [Failure triage](./running.md#failure-triage). |
| `ccqa run --on-fail-explain-rerun auto` | Run a failure the classifier could not pin down a second time, and label it from whether it reproduces. Costs a full spec execution each; the spec stays failed either way. See [Rerunning a failure](./running.md#rerunning-a-failure). |
| `ccqa audit [feature/spec]` | Audit specs against the codebase without running a browser. See [Drift detection](./running.md#drift-detection). |
| `ccqa audit --only-hub-audit-needed` | Audit only the specs a deploy has reached since the audit last read them, plus every spec never audited and every spec whose drift entry is still open. See [Auditing only what the deploy reached](./running.md#auditing-only-what-the-deploy-reached). |
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
| `ccqa hub deploy record --profile <p> --sha <sha>` | Tell the hub what a deploy shipped, and which specs it reaches. `--no-select-specs` skips the second half, so every spec behind it is assumed reached instead of cleared. See [`ccqa hub deploy record`](./hub.md#ccqa-hub-deploy-record). |
| `ccqa hub prompt push / ls / rm` | Manage per-flow guidance and learned prompts. See [Triage learning](./hub.md#triage-learning). |
| `ccqa hub cost push --label <name>` | Sum `$CCQA_COST_FILE` and record the total on the hub as one spend entry — what a budget reads instead of summing runs. See [Spend](./hub-api.md#spend). |
| `ccqa hub attest <feature/spec> --profile <p> --by <name>` | Record that a person checked the spec by hand: the verdict answers `manuallyVerified` until a deploy reaches the spec or the spec is edited. `--revoke` withdraws it. See [Manual attestations](./hub-api.md#manual-attestations). |

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `CCQA_HUB_URL` | every client command | Same as `--hub-url`. |
| `CCQA_HUB_TOKEN` | every client command, `ccqa serve` | Same as `--hub-token`. The hub refuses to start without it. |
| `CCQA_HUB_HEADER` | every client command | One extra header as `name:value`, for a hub behind an authenticating proxy. Repeatable as `--hub-header`. |
| `CCQA_HUB_ENCRYPTION_KEY` | `ccqa serve` | 64 hex characters. Optional, but without it the hub returns 503 for session and variable writes — they are never stored in the clear. See [Encryption](./hub.md#encryption). |
| `CCQA_MODEL` | anything that calls Claude | Default model. Same as `-m/--model`. |
| `CCQA_COST_FILE` | anything that calls Claude | Path to append one JSON line per invocation to. See [What a command cost](#what-a-command-cost). |
| `ANTHROPIC_API_KEY` | anything that calls Claude | One of the accepted credentials, alongside `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` and a local `claude` login. In CI there is nothing to log into, so one of these must be set. |
| `ANTHROPIC_BASE_URL` | anything that calls Claude | Endpoint to send requests to. Forwarded verbatim; see [Pointing at another endpoint](#pointing-at-another-endpoint). |
| `ANTHROPIC_AUTH_TOKEN` | anything that calls Claude | Sent as `Authorization: Bearer <token>`, when a bearer token is used instead of an API key. |
| `ANTHROPIC_CUSTOM_HEADERS` | anything that calls Claude | Extra request headers. |

Which commands call Claude, and therefore need a credential: `draft`,
`perspectives`, `record`, `generate`, `audit`, `select-specs`,
`hub deploy record`, `run` on a `mode: live` spec, and
`run --on-fail-explain`. A deterministic `ccqa run` calls no model at all.

`serve` belongs on that list too, but for a different reason: the hub does no
model work of its own except the prompt-learning job a human starts from the
UI, which runs one Claude call on the server. A hub that will never be asked
to learn needs no credential; one that will, does.

## Pointing at another endpoint

ccqa never reads or interprets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_API_KEY` or `ANTHROPIC_CUSTOM_HEADERS` — it forwards whichever are
set to the Claude Code process underneath. Anything that speaks the Anthropic
API works without a ccqa change: set the endpoint and the credential, and name
the model with `-m/--model` or `CCQA_MODEL`.

An endpoint variable that is set but **empty** is dropped rather than
forwarded, so a CI job can wire the key unconditionally — an unset repository
variable renders as `""`, and passing that through would override the default
endpoint with nothing.

One thing degrades. `total_cost_usd` is the SDK's own estimate, computed from
a pricing table it only has for models it knows, so a third-party model
reports usage but no price. Token counts come from the API response and
survive, which is why the `[cost]` line drops the price segment rather than
the whole line, and why the JSONL still records the invocation with
`"totalCostUsd": null`. Read tokens, not dollars, when comparing models this
way — and treat a `$0.0000` total as "no price available" rather than "free".

## What a command cost

Every command in the first list ends by writing what it spent to **stderr** —
stdout is left to the machine-readable output that `--report-format json`
and `select-specs` put there:

```
[cost] $1.8342 / 46 turns / 42+6511 tokens / 2004992 cache-read / model=claude-sonnet-4-6
```

One line covers the whole invocation, not one call: a `ccqa run` that
selected specs, drove a live browser and triaged two failures reports the
sum. A command that called no model prints nothing.

Set `CCQA_COST_FILE` to accumulate those numbers across a job. Each
invocation **appends** one JSON line, so several commands can share one
file:

```bash
export CCQA_COST_FILE=$RUNNER_TEMP/ccqa-cost.jsonl
ccqa select-specs --base "$GITHUB_BASE_REF"
ccqa audit --only-affected-by "$GITHUB_BASE_REF"
ccqa run --only-affected-by "$GITHUB_BASE_REF"
jq -s 'map(.totalCostUsd // 0) | add' "$CCQA_COST_FILE"
```

Each line carries `command`, `at`, `totalCostUsd`, `numTurns`,
`inputTokens`, `outputTokens`, `cacheReadInputTokens` and `models`. A
command that was not billed still writes its line, with
`"totalCostUsd": null` — that it ran and cost nothing is an answer, and a
missing line would read as a missing run. A file that cannot be written is
never fatal: cost telemetry does not fail the command it measures.

To keep that number after the job's workspace is gone, push it to the hub as
the job's last step:

```bash
ccqa hub cost push --label "$GITHUB_JOB"
```

One entry per job, added up per project by the hub — the number a budget reads
instead of summing the hub's runs, never alongside it. See
[Spend](./hub-api.md#spend).

`ccqa run` additionally records its spend in the report — see
[The run report](./running.md#the-run-report).

Two things are outside these totals. `serve`'s prompt-learning job bills on
the hub, which is a long-running process rather than a command that ends, so
it writes no line. And `run --learn-hub-live-prompt` refreshes the prompt
after the report is written and sealed, so that call reaches the `[cost]`
line and the JSONL but not the report or the hub. Where the numbers have to
add up, the JSONL is the one to trust.
