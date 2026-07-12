# Live specs (`mode: live`)

This is the detail page for `mode: live` specs — the alternative to the deterministic record → vitest-replay flow.

For specs declared `mode: live` in their spec.yaml, `ccqa run` skips codegen entirely: Claude executes each spec step against `agent-browser` directly, judges whether the step's `expected` outcome holds, and saves a PNG screenshot before and after every step. Use this mode when:

- you want to validate a spec but don't yet need a replayable, recorded test
- the codegen output for a spec is fragile (heavily timing-dependent UIs, rich-text editors, dynamic selectors)
- you want a visual audit trail of what the page looked like at every step

```bash
# Run a single live spec
ccqa run tasks/create-and-complete

# Run every spec under a feature (mixes deterministic + live as declared)
ccqa run tasks

# Run every spec in the project, into a unified report (report.json + evidence)
ccqa run --report

# Retry each failing step up to 2 more times (live specs only)
ccqa run --retry 2 tasks/create-and-complete
```

Constraints on selectors / `agent-browser` subcommands that apply during `ccqa record` (no `eval`, no `@ref`, no bare-tag positional `find`, no chained agent-browser calls) are **relaxed** for live specs — Claude can use any subcommand and any selector style because there is no replay contract to honour.

## Per-project guidance (hub prompts `live.user` / `live.agent`)

ccqa's live-mode system prompt is deliberately product-agnostic. Anything specific to **your** project — staging URLs, login flow quirks, rich-editor types, common access-denied wording — belongs in a pair of prompts stored on the [hub](./hub.md), per project:

- `live.user` — human-maintained stable guidance. Edit it in the hub UI's Prompts tab, or locally in `.ccqa/prompts/live.user.md` and upload with `ccqa hub prompt push live.user`.
- `live.agent` — auto-updated on the hub by `ccqa run --update-agent-prompt` from each run's summary. You can push a hand-edited version, but the next `--update-agent-prompt` run may rewrite it; durable rules should live in `live.user`.

When hub credentials are configured, `ccqa run` fetches both prompts once per invocation and appends them to the system prompt (missing or unreachable prompts never stop a run — you just run without guidance). The `ccqa record` (trace) side has the same split: `record.user` + `record.agent`, refreshed by `ccqa record --update-agent-prompt`.

Keep them short. A page or two of focused notes beats a long handbook — Claude has the spec's `expected` text to work from, these files are for the *non-obvious* product knowledge that isn't in any single spec. Examples of what's useful here:

- "the rich text editor is `[contenteditable='true']` — use `fill`, not keystrokes"
- "login redirects through an IDP service-selection screen; you can skip it by opening the destination URL directly"
- "access-denied is signalled by a specific in-app message string — name it here so the model asserts on it"

Examples of what does **not** belong:

- per-spec details (those belong in the spec's `instruction` / `expected`)
- restating the STEP_RESULT contract (already in the system prompt)
- copy-pasted style guidelines from `record.user.md` (the relaxed-constraint mode doesn't need them)

The combined bundle is capped at 32 KiB; anything beyond that is truncated with a warning.

## Related docs

- [Saved sessions](./sessions.md) — restore signed-in browser state (cookies + localStorage) into a live spec via `session:`.
- [Hub](./hub.md) — aggregate live-spec run reports across CI runs.
