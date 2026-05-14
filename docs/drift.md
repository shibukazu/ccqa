# Drift detection in CI

`ccqa drift` checks every `test-spec.md` against the current codebase and reports anywhere they have fallen out of sync — renamed aria-labels, removed routes, missing setups, assertions about UI that no longer exists. No browser, no LLM-driven actions, no patches applied: a read-only review designed for CI.

```bash
ccqa drift                              # check every spec under .ccqa/features/
ccqa drift tasks/create-and-complete    # single spec
ccqa drift --format github              # emit GitHub Actions annotations
ccqa drift --format json                # machine-readable output
ccqa drift --severity warn              # exit non-zero on WARN or higher (default: error)
ccqa drift --concurrency 5              # parallel spec checks (default: 3)
ccqa drift --cwd packages/web           # for monorepos: pin .ccqa root and codebase scope
ccqa drift --changed                    # only check specs affected by the PR diff
ccqa drift --changed --base origin/dev  # diff against an explicit base ref
```

## Scoping with `--changed` and `relatedPaths`

Running drift on every spec for every PR is expensive. To scope a CI run to the
specs that the PR actually touches, pass `--changed`.

Each `test-spec.md` may declare a `relatedPaths` list in its YAML frontmatter:

```yaml
---
title: "Create and complete a task"
baseUrl: "http://localhost:3000"
relatedPaths:
  - src/features/tasks/**
  - src/app/tasks/page.tsx
---
```

These are glob patterns identifying the source files the spec depends on. Both
`ccqa draft` (provisional) and `ccqa trace` (refined from real browser
observations — URLs visited, aria-labels clicked, etc.) maintain this list, so
typically you do not write it by hand. Commit `relatedPaths` to git alongside
the spec — that way reviewers see which areas a spec covers.

When `--changed` is set, `ccqa drift`:

1. Runs `git diff --name-status base...HEAD` (base = `--base`, else
   `$GITHUB_BASE_REF`, else `origin/main`).
2. Intersects modified/deleted/renamed files with each spec's `relatedPaths`
   globs. A spec is in-scope if any change matches.
3. For **new files** (added in the PR), runs a single lightweight Claude call
   that maps each new file to the specs it plausibly affects. This catches
   drift in code that no existing `relatedPaths` glob could know about yet.
4. Specs with no `relatedPaths` declared (e.g. fresh specs that have never been
   traced) are always considered in-scope — `--changed` is safe to enable
   incrementally during a migration.

Supported glob syntax: `**` (any depth), `*` (run of non-slash chars), `?`
(single non-slash char). Globs are intentionally minimal — keep `relatedPaths`
human-readable rather than tuned.

### Monorepo paths

`relatedPaths` are interpreted **relative to the cwd** that `ccqa drift` runs
in (the same one that hosts `.ccqa/`). In a monorepo, run drift from each
package's directory (or use `--cwd packages/foo`) and write
`relatedPaths` as the package would see them — e.g. `src/features/tasks/**`,
not `packages/foo/src/features/tasks/**`. Changes outside the cwd are
ignored, so a PR that only touches a sibling package never scopes this
package's specs in.

## Authentication in CI

`ccqa drift` is the one Claude-driven command intended to run unattended, so it accepts an Anthropic API key. Set `ANTHROPIC_API_KEY` in your CI secrets and the SDK picks it up automatically — no Claude Code login required. Locally, the existing Claude Code login keeps working; the API key takes precedence when both are present.

## GitHub Actions example

```yaml
name: ccqa drift
on: [pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec ccqa drift --changed --format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The PR-scoped form above uses `$GITHUB_BASE_REF` as the diff base automatically.
For a periodic full sweep that does not skip any spec, run `ccqa drift` (without
`--changed`) from a scheduled workflow.

For a monorepo where each package has its own `.ccqa/`, point `--cwd` at the package root:

```yaml
      - run: pnpm exec ccqa drift --cwd packages/web --format github
```
