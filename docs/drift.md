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
```

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
      - run: pnpm exec ccqa drift --format github
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

For a monorepo where each package has its own `.ccqa/`, point `--cwd` at the package root:

```yaml
      - run: pnpm exec ccqa drift --cwd packages/web --format github
```
