# Drift detection

Drift analysis asks Claude whether each `spec.yaml` is still in sync with the current codebase, surfacing renamed aria-labels, removed routes, missing blocks, and assertions about UI that no longer exists. It is read-only: no browser, no patches.

There are two ways to invoke drift:

1. **`ccqa run --drift-report`** — the common case. When `ccqa run` finishes, an HTML run report is written; each failing spec gets a drift audit plus a three-way root-cause call. See [Run report](./report.md) for the full feature and [Auto-fix](./auto-fix.md) for how this complements the `generate` auto-fix loop.
2. **`ccqa drift`** — standalone. Use this for a full audit (scheduled job, pre-merge sweep), or to inspect a single spec without running its test. The flags below describe this mode.

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

Each `spec.yaml` may declare a top-level `relatedPaths` list:

```yaml
title: Create and complete a task
relatedPaths:
  - src/features/tasks/**
  - src/app/tasks/page.tsx
steps:
  - instruction: ...
    expected: ...
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
   traced) are always considered in-scope.

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

Primary path — `ccqa run --drift-report`. The deterministic vitest run gates the build; the report (with drift audit and failure analysis) is uploaded as an artifact — see [Run report](./report.md) for the recommended workflow.

Standalone full sweep — `ccqa drift` — for scheduled audits that run regardless of test status:

```yaml
name: ccqa drift audit
on:
  schedule:
    - cron: "0 9 * * 1"   # weekly Monday 09:00 UTC
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec ccqa drift --format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

For a monorepo where each package has its own `.ccqa/`, point `--cwd` at the package root:

```yaml
      - run: pnpm exec ccqa drift --cwd packages/web --format github
```
