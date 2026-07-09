# Run report

`ccqa run` always writes a **machine-readable report** of the run — a
`report.json` plus the per-step evidence PNGs — meant to be pushed to the
[ccqa hub](./hub.md) (`ccqa hub push`, or streamed incrementally with
`--push-report`) and viewed in the hub UI, or consumed directly by CI
tooling. There is no standalone HTML file: the hub UI is the report,
rendering results from `report.json` and the evidence images it serves
over its API.

```bash
ccqa run                                   # writes ccqa-report/report.json (+ evidence/)
ccqa run --report my-report                # write to a custom output directory instead
ccqa run --base origin/main                # base ref for the source diff
```

## What the report contains

- A run summary: every spec with its pass/fail status and test counts.
- For each spec, a **step-evidence gallery**: one PNG screenshot per `spec.yaml`
  step (plus a JSON sidecar with URL/title/timestamp) so a reviewer can confirm
  the test actually drove the app through the intended states. Captured by
  default; pass `--no-evidence` to skip. Files land in
  `<report-dir>/evidence/<feature>/<spec>/<stepId>.{png,json}`, are referenced
  from `report.json`, and are served by the hub UI over its API; they are
  written to disk on every run, regardless of whether `--report` is passed.
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

The root-cause call is known to be hard, so ccqa is built measurement-first:
after pushing a run, the [hub UI](./hub.md#the-bundled-ui) is the **grading UI**.

1. Open a failing run in the hub and review a failing spec (you are
   investigating the failure anyway).
2. Pick the true cause with the segmented control (`TEST_DRIFT` / `SPEC_CHANGE`
   / `PRODUCT_BUG`); the grade is saved to the hub.
3. A confusion matrix (predicted × actual, including UNKNOWN predictions) and
   overall accuracy update live.

Grades are stored on the hub (keyed to the run's analysis `promptVersion`, so
numbers from different prompt iterations are never mixed), and they feed the
[triage-learning](./hub.md#triage-learning) job that improves the analysis
custom prompt over time.

## How the diff context is resolved

The base ref for the source diff follows the same precedence as `ccqa drift --changed`:

1. explicit `--base <ref>`
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
      - run: pnpm exec ccqa run
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ccqa-report
          path: ccqa-report/
```

Add `ccqa-report/` to the consuming repo's `.gitignore`. To also push results
to a hub incrementally as the run progresses, add `--push-report` (plus hub
credentials) to the `ccqa run` step — see [docs/hub.md](./hub.md).

## Migrating from `ccqa run --drift` / `--drift-strict`

`ccqa run --drift`, `ccqa run --drift-strict`, and `ccqa run --drift-report` were all unified into `--report`: the same drift audit now lands inside the report (and feeds the root-cause analysis) instead of being printed to stdout.

- `--drift` / `--drift-report` → `--report`.
- `--drift-strict` (fail the build on drift ERRORs even when tests pass) → run the standalone [`ccqa drift`](./drift.md) as its own CI step; it audits without running tests and exits non-zero on findings.

## Authentication

Credentials follow the same rules as [`ccqa drift`](./drift.md#authentication-in-ci): `ANTHROPIC_API_KEY` in CI, or a local Claude Code login. When neither is available the report is still written — only the analysis is skipped, with the reason shown per case.
