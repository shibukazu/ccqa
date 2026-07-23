/**
 * Shared constants + helpers for step-boundary evidence: the env var that
 * enables capture, the file-name sanitizer, and the reserved failure ids.
 *
 * Three producers write the `<id>.png` + `<id>.json` pairs — `abStepEvidence()`
 * / `captureFailureEvidence()` in `test-helpers.ts` (agent-browser replays) and
 * `ccqaStepBefore`/`ccqaStepAfter` in `step-evidence.ts` (external targets) —
 * and one consumer reads them back (`loadEvidenceForSpec` in
 * `report/evidence.ts`). All four agree only on the contract here, so it is
 * kept under `runtime/` (free of CLI-side imports) so the generated-test
 * modules — imported via `ccqa/test-helpers` and `ccqa/step-evidence` — can
 * share it without dragging the CLI in.
 */

/**
 * Env var naming the directory a spec's step evidence is written to. `ccqa
 * run` sets it per spec; unset means "capture nothing", which is what keeps a
 * hand-run generated test (or the generation-time verify loop) from
 * scattering screenshots.
 */
export const EVIDENCE_DIR_ENV = "CCQA_EVIDENCE_DIR";

/**
 * Make a step id safe to use as an evidence file-name stem. Both evidence
 * producers (agent-browser `abStepEvidence`, external `ccqa/step-evidence`)
 * name their PNG/JSON pair `<stem>.png` / `<stem>.json`, so they must agree on
 * this exact mapping.
 */
export function sanitizeStepId(stepId: string): string {
  return stepId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** stepId reserved for the screenshot captured by fail() at the moment of an assertion failure. */
export const FAILURE_STEP_ID = "failure";

/** source value paired with FAILURE_STEP_ID so the report can tell failure captures apart from step captures. */
export const FAILURE_SOURCE = "failed";
