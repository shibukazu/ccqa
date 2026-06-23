# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## What ccqa is

ccqa is a **general-purpose, product-agnostic** QA tool that turns Claude Code into a
browser test recorder/runner. It is published on npm and used against arbitrary
downstream applications. Because it is a generic tool, **nothing in this repository
may reference, embed, or leak details of any specific downstream product or its
environment.**

## Confidentiality: never leak product-specific or sensitive information

This is the most important rule in this repository. ccqa is consumed by third parties,
so its source, comments, prompts, docs, commit messages, PR titles/descriptions, and
test fixtures **must stay neutral and generic**.

### Never commit any of the following

- **Downstream-product UI strings as examples.** Do not use real button labels, menu
  items, screen copy, or error messages from any specific application. Use neutral,
  language-agnostic placeholders instead (e.g. `"Submit"` button, `"you don't have
  permission"` message — not real product copy).
- **Concrete test-case / spec identifiers** from a real project (e.g. a real spec path
  like `some-feature/do-the-thing`). In examples, ADRs, and prompts, describe the
  shape generically instead of naming a real case.
- **Secrets and environment details**: URLs, hostnames, tenant/org/workspace names,
  account names, API keys, tokens, cookies, credentials, internal IP addresses.
- **Personal data**: names, emails, or any PII captured while recording against a
  real app.
- **Screenshots, traces, HTML reports, or `.spec.ts` fixtures** generated against a
  real application. These belong to the consumer's project, never to this repo.

### When writing examples, comments, or prompts

- Prefer neutral English placeholders (`"Submit"`, `"Save"`, `"Cancel"`) over copy from
  any specific product, in any language.
- If you need to illustrate a flow, invent a generic example (a todo app, a login
  form) rather than reusing something you saw in a real downstream spec.
- Prompt strings under `src/prompts/` ship to end users' Claude sessions — treat them
  as public, user-facing surface and keep them generic.

### Before every commit / PR

- Re-read your diff and confirm no real product copy, identifiers, URLs, secrets, or
  PII slipped in — including in **commit messages and PR descriptions**, not just code.
- Quick self-check greps (extend with terms relevant to your context):

  ```sh
  git diff --cached | grep -nE 'https?://|token|secret|password|cookie|tenant'
  ```

- If you find such a string already in the tree, redact it and call it out rather than
  silently leaving it.

## Project layout

- `bin/ccqa.ts` — CLI entry point.
- `src/cli/` — command wiring. `src/spec/` — spec parsing/types. `src/codegen/` —
  action → `test.spec.ts` compilation. `src/runtime/` — live execution. `src/prompts/`
  — Claude prompt strings (user-facing). `src/diagnose/`, `src/drift/`, `src/report/`,
  `src/store/` — supporting subsystems.
- `docs/` — user docs (`README.ja.md` is the Japanese README; `docs/adr/` holds ADRs).
- `tests/e2e/` — end-to-end tests.

## Development workflow

- **Type check**: `pnpm typecheck`
- **Unit tests**: `pnpm test:unit`
- **All tests**: `pnpm test`
- **Build**: `pnpm build` (tsdown → ESM artifact in `dist/`)
- Before declaring work done: run `pnpm typecheck` and the relevant tests, and confirm
  the confidentiality self-check above.

## Releases

- Version is bumped via the `release` GitHub Actions workflow (`workflow_dispatch`),
  which runs `pnpm version <patch|minor|major>` against `package.json` and pushes the
  resulting `chore: release <version>` commit + tag, then publishes to npm.
- The source of truth for the version is **`package.json`**, not git tags. Choosing
  `major` from `0.9.x` produces `1.0.0`.
