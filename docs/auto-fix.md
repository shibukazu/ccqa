# Auto-fix

If the generated script fails, `generate` invokes an LLM to diagnose the failure and propose a fix. The diagnosis is one of:

- **TIMING_ISSUE** — insert or extend `sleep` so the page has time to settle.
- **OVER_ASSERTION** — remove `abAssert*` lines that the spec doesn't actually require.
- **SELECTOR_DRIFT** — replace a renamed selector with the new one. The diagnose LLM is allowed to `Grep` / `Read` your repository (read-only) to find the actual `aria-label` / `placeholder` / `data-testid` / i18n string in the app source, so renames in the UI code are caught even when the failure log only says "selector not visible".
- **DATA_MISSING** / **UNKNOWN** — not auto-fixable; the loop bails and reports the diagnosis.

Each diagnosis has a `confidence` score. By default high-confidence fixes are applied automatically; low-confidence fixes drop into an interactive `[a]pply / [s]kip / [m]anual / [q]uit` prompt.

```bash
ccqa generate tasks/create-and-complete                  # default: interactive on low confidence
ccqa generate tasks/create-and-complete --auto           # CI: always auto-apply
ccqa generate tasks/create-and-complete --no-interactive # CI: auto-apply on high confidence, give up otherwise
ccqa generate tasks/create-and-complete --max-retries 5
```

> **Note**: `generate` regenerates `test.spec.ts` from `actions.json` on every run. Manual edits to `test.spec.ts` are lost on the next `generate`. When an existing `test.spec.ts` is detected, `generate` always asks for `y/N` confirmation before overwriting (even with `--auto` / `--no-interactive`). To skip the prompt in CI, pass `--force`. To persist a fix, re-run `trace` so `actions.json` reflects the new flow.
