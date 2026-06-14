/**
 * Shared constants for step-boundary evidence captured by abStepEvidence() /
 * captureFailureEvidence() and consumed by the run report. Kept under
 * `runtime/` so the test-helpers module — which generated test scripts import
 * via `ccqa/test-helpers` — can stay free of CLI-side imports while still
 * sharing the literal with run.ts.
 */

/** stepId reserved for the screenshot captured by fail() at the moment of an assertion failure. */
export const FAILURE_STEP_ID = "failure";

/** source value paired with FAILURE_STEP_ID so the report can tell failure captures apart from step captures. */
export const FAILURE_SOURCE = "failed";
