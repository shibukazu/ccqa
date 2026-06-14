import { join } from "node:path";

export interface StepArtifactPaths {
  beforePng: string;
  afterPng: string;
  logTxt: string;
}

/**
 * Build a sortable run id from the current wall-clock time. ISO8601 with
 * `:` / `.` replaced so it's filename-safe. Caller is expected to mkdir the
 * directory once and pass `runDir = <baseDir>/<runId>` to the path helpers
 * below.
 */
export function buildRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Per-step artifact paths under a run directory. `<runDir>/steps/<stepId>.*`.
 * Three files per step:
 *   - <stepId>.before.png : screenshot taken BEFORE Claude executes the step.
 *   - <stepId>.after.png  : screenshot taken AFTER  Claude executes the step.
 *   - <stepId>.log.txt    : full assistant transcript for the step (judgement
 *                           reasoning, any STEP_RESULT lines, raw tool output
 *                           summaries the model chose to keep).
 */
export function stepArtifactPaths(runDir: string, stepId: string): StepArtifactPaths {
  const dir = join(runDir, "steps");
  return {
    beforePng: join(dir, `${stepId}.before.png`),
    afterPng: join(dir, `${stepId}.after.png`),
    logTxt: join(dir, `${stepId}.log.txt`),
  };
}
