# Auto-fix

If the generated script fails, `record` invokes an LLM to diagnose the failure and propose a fix. The diagnosis is one of:

- **TIMING_ISSUE** — insert or extend `sleep` so the page has time to settle.
- **OVER_ASSERTION** — remove `abAssert*` lines that the spec doesn't actually require.
- **SELECTOR_DRIFT** — replace a renamed selector with the new one. The diagnose LLM is allowed to `Grep` / `Read` your repository (read-only) to find the actual `aria-label` / `placeholder` / `data-testid` / i18n string in the app source, so renames in the UI code are caught even when the failure log only says "selector not visible".
- **DATA_MISSING** / **UNKNOWN** — not auto-fixable; the loop bails and reports the diagnosis.

Each diagnosis has a `confidence` score. By default high-confidence fixes are applied automatically; low-confidence fixes drop into an interactive `[a]pply / [s]kip / [m]anual / [q]uit` prompt.

```bash
ccqa record tasks/create-and-complete                    # default: interactive on low confidence
ccqa record tasks/create-and-complete --auto-fix auto     # CI: always auto-apply
ccqa record tasks/create-and-complete --auto-fix skip     # CI: auto-apply on high confidence, give up otherwise
ccqa record tasks/create-and-complete --max-retries 5
```

> **Note**: `record` regenerates `test.spec.ts` from `ir.json` on every run. Manual edits to `test.spec.ts` are lost on the next `record`. When an existing `test.spec.ts` is detected, `record` always asks for `y/N` confirmation before overwriting (even with `--auto-fix auto` / `--auto-fix skip`). To skip the prompt in CI, pass `--force`. To persist a fix, re-run `record` so `ir.json` reflects the new flow.
