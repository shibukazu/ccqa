# 0005. Restore browser sessions by name, not by spec-embedded path

- Status: accepted
- Date: 2026-07-01

## Context and problem statement

Live specs could start signed-in via a top-level `statePath: <path>` pointing at
a saved agent-browser state file (cookies + localStorage). But that file holds
live auth cookies and must never be committed, while `spec.yaml` is committed —
so a Git-managed file embedded a path to a Git-ignored credential. Worse, a
missing file aborted the spec with a bare "missing file" error, so a checkout
without the state couldn't run at all, and the spec leaked an environment-
specific path into shared source.

## Considered options

- Keep `statePath:` but expand `${VAR}` and warn-and-continue on a miss.
- Add an `auth:` model: a catalog of roles/providers/login steps ccqa owns.
- Replace it with `session:` — spec names a saved session; ccqa only restores it.

## Decision outcome

Chosen option: "`session:`", because ccqa should not own authentication — it
should only optionally restore browser state, keeping specs free of paths and
credentials.

- A spec declares `session: <name>` (or a list). Names are slugs; no paths.
- ccqa resolves each name to `.ccqa/sessions/<profile>/<name>.json` and restores
  it read-only via agent-browser's `--state`. Several names are merged (cookies
  and per-origin storage unioned) into one state, so a spec can start signed-in
  to multiple providers.
- `ccqa session bootstrap <name>` opens a headed browser, the user logs in by
  hand, and ccqa saves the session. ccqa carries no login steps of its own.
- A spec that just logs in normally omits `session` and does it in its steps.

### Consequences

- Good: specs carry intent only (which identity), never paths or secrets;
  sessions are shared by name across specs; multi-provider restore is first-class.
- Bad / cost: a named-but-missing session is a hard stop (the spec assumes it's
  signed in) — surfaced with a `ccqa session bootstrap` hint rather than running
  unauthenticated. `statePath:` is removed (breaking for specs that used it).
- Follow-up: `ccqa session export`/`import` helpers for CI restore if the manual
  base64 round-trip proves cumbersome.

### Confirmation

Unit tests cover session-name validation, path resolution, multi-session merge
(union, last-wins), and the missing-session error. A live spec was run locally
against a bootstrapped session to confirm restore, the missing-session hint, and
the merged multi-session path.

## More information (optional)

- `src/spec/yaml-schema.ts` (`SessionFieldSchema`), `src/runtime/session-state.ts`
  (path + merge), `src/cli/run-live.ts` (`resolveSessionState`), `src/cli/session.ts`.
- Supersedes the `statePath:` field introduced for pre-authenticated live runs.
