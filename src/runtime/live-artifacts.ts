import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface StepArtifactPaths {
  beforePng: string;
  afterPng: string;
  logTxt: string;
}

/**
 * Build a sortable, unique run id. ISO8601 with `:` / `.` replaced so it's
 * filename-safe, timestamp first so run directories still sort by time, and a
 * random suffix because the timestamp alone does not separate two specs.
 *
 * The pool launches specs back-to-back, so at `--concurrency > 1` two of them
 * land in the same millisecond. A spec that puts `${CCQA_RUN_ID}` in the name
 * of something it creates would then share that name with its neighbour, and
 * each would find — and delete — the other's row. Nothing fails; the
 * assertions just read the wrong state.
 *
 * Caller is expected to mkdir the directory once and pass
 * `runDir = <baseDir>/<runId>` to the path helpers below.
 */
export function buildRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
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
