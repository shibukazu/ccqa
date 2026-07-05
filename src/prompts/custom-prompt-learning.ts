import type { GradedCase } from "./custom-prompt.ts";

/**
 * Prompts for a triage-learning job: turn a batch of human-graded triage
 * cases into a short prose calibration note that captures this project's
 * classification tendencies, stored as the analysis custom prompt's guidance.
 *
 * These prompt strings are generic (they ship in the ccqa repo). The
 * project-specific content is entirely in the graded cases passed in at run
 * time — never hard-coded here.
 */

export const LEARNING_SYSTEM_PROMPT = `You distill human-graded failure classifications into a short calibration note for a downstream failure-analysis classifier.

The classifier decides, for a failing E2E test after a source change, which of three causes applies:
- TEST_DRIFT: the test drifted from the source (selector/timing/over-assertion); the intended behaviour is unchanged.
- SPEC_CHANGE: the verified behaviour itself changed on purpose.
- PRODUCT_BUG: an unintended regression.

You are given cases a human already graded — the model's prediction and the human's ground-truth label. Your job: write 3-6 sentences of calibration guidance that would help the classifier match this project's human judgements next time. Focus on the patterns where the model tended to be WRONG (prediction != actual). Be concrete about the project's conventions, but do NOT invent facts beyond the cases shown.

Output ONLY the calibration note as plain prose — no preamble, no headings, no markdown fences, no bullet lists longer than the note itself. If the cases show no useful pattern, output a single sentence saying the graded cases are too few or too varied to generalize.`;

/** Build the user message listing the graded cases to learn from. */
export function buildLearningUserPrompt(cases: GradedCase[]): string {
  const lines = cases.map((c, i) => {
    const verdict = c.matches ? "model was correct" : `model predicted ${c.predicted}, human corrected to ${c.actualCause}`;
    return `Case ${i + 1} (${c.actualCause}; ${verdict})\n  Failure signal: ${c.evidenceSignal}`;
  });
  return `Here are ${cases.length} graded failure classifications from this project:\n\n${lines.join("\n\n")}\n\nWrite the calibration note.`;
}
