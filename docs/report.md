# Run report

`ccqa run --drift-report` writes a **self-contained HTML report** of the run — one file, inline CSS/JS, no server — meant to be uploaded as a CI artifact the same way Playwright's HTML report is.

```bash
ccqa run --drift-report                          # writes ccqa-report/index.html
ccqa run --drift-report my-report                # custom output directory
ccqa run --drift-report --drift-base origin/main # base ref for the source diff
```

## What the report contains

- A run summary: every spec with its pass/fail status and test counts.
- For each spec, a **step-evidence gallery**: one PNG screenshot per `spec.yaml`
  step (plus a JSON sidecar with URL/title/timestamp) so a reviewer can confirm
  the test actually drove the app through the intended states. Captured by
  default; pass `--no-evidence` to skip. Files land in
  `<report-dir>/evidence/<feature>/<spec>/<stepId>.{png,json}` and are linked
  from the report; they survive on disk even when `--drift-report` is not
  passed, so they work as a standalone CI artifact.
- For each **failing** spec:
  - a **root-cause call** made by Claude with the PR diff as context:
    - `TEST_DRIFT` — what the spec verifies is unchanged; only the test code drifted from the source (selector rename, timing, over-assertion)
    - `SPEC_CHANGE` — the thing being verified itself changed (UI redesign, spec change); the diff hunk is cited as evidence
    - `PRODUCT_BUG` — neither of the above explains the failure
    - `UNKNOWN` — evidence too weak to choose
  - the prediction's confidence, sub-diagnosis, evidence, and reasoning,
  - the spec↔code [drift audit](./drift.md) findings,
  - the failure log, the scoped source diff, and the spec.yaml.

The failure analysis classifies; it never modifies anything. The exit code of `ccqa run` is determined by vitest alone — the report never changes it.

## Measuring prediction accuracy

The root-cause call is known to be hard, so the report is built measurement-first: it is also the **grading UI**.

1. Open the report and review a failing case (you are investigating the failure anyway).
2. Pick the true cause with the radio buttons (`TEST_DRIFT` / `SPEC_CHANGE` / `PRODUCT_BUG`) and optionally leave a note.
3. The accuracy panel recomputes live: overall accuracy, a confusion matrix (predicted × actual, including UNKNOWN predictions), and per-class precision / recall / F1.

Labels are saved in the browser's localStorage and can be **exported/imported as JSON**, so grading work survives the session and can be collected across runs. The export embeds the analysis `promptVersion`, so numbers from different prompt iterations are never silently mixed.

## How the diff context is resolved

The base ref for the source diff follows the same precedence as `ccqa drift --changed`:

1. explicit `--drift-base <ref>`
2. `GITHUB_BASE_REF` (set automatically on `pull_request` events)
3. `origin/main`

For each failing spec the diff is scoped to its [`relatedPaths` globs](./drift.md#scoping-with---changed-and-relatedpaths) (falling back to the full diff when nothing matches — "no related change" is itself a PRODUCT_BUG signal) and truncated to keep the prompt bounded. When the diff cannot be captured at all (e.g. not a git checkout), the analysis still runs, with lower expected confidence.

## GitHub Actions example

```yaml
name: ccqa
on: [pull_request]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # the diff needs the base ref
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec ccqa run --drift-report
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ccqa-report
          path: ccqa-report/
```

Add `ccqa-report/` to the consuming repo's `.gitignore`.

## Migrating from `ccqa run --drift` / `--drift-strict`

`ccqa run --drift` and `ccqa run --drift-strict` were replaced by `--drift-report`: the same drift audit now lands inside the report (and feeds the root-cause analysis) instead of being printed to stdout.

- `--drift` → `--drift-report`.
- `--drift-strict` (fail the build on drift ERRORs even when tests pass) → run the standalone [`ccqa drift`](./drift.md) as its own CI step; it audits without running tests and exits non-zero on findings.

## Authentication

Credentials follow the same rules as [`ccqa drift`](./drift.md#authentication-in-ci): `ANTHROPIC_API_KEY` in CI, or a local Claude Code login. When neither is available the report is still written — only the analysis is skipped, with the reason shown per case.
