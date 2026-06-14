/**
 * Non-deterministic mode (`ccqa run-nd`) judges each spec step with a single
 * Claude turn. The model emits its verdict as a STEP_RESULT line that lives in
 * the same pipe-delimited family as trace mode's STEP_DONE / AB_ACTION, so we
 * parse it with the same shape.
 *
 * Wire format (one line, no surrounding code fence):
 *
 *   STEP_RESULT|<stepId>|<pass|fail>|<reason>
 *
 * `reason` is free-form text; pipes inside it are joined back with `|` so the
 * model doesn't have to escape them. Empty reason is allowed. Anything other
 * than `pass` / `fail` in the status slot fails the parse (treated as a fail
 * with "STEP_RESULT missing" by the caller).
 */
export interface StepJudgement {
  stepId: string;
  status: "pass" | "fail";
  reasoning: string;
}

const MAX_REASON_LEN = 2000;

/** Parse a single STEP_RESULT line. Returns null on malformed input. */
export function parseStepResultLine(line: string): StepJudgement | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("STEP_RESULT|")) return null;
  const parts = trimmed.split("|");
  // ["STEP_RESULT", stepId, status, ...reasonParts]
  if (parts.length < 3) return null;
  const stepId = parts[1]?.trim() ?? "";
  const rawStatus = parts[2]?.trim().toLowerCase() ?? "";
  if (stepId === "") return null;
  if (rawStatus !== "pass" && rawStatus !== "fail") return null;
  const reasoning = parts.slice(3).join("|").trim().slice(0, MAX_REASON_LEN);
  return { stepId, status: rawStatus, reasoning };
}

/**
 * Scan the full assistant transcript for the last well-formed STEP_RESULT
 * line. The model is instructed to emit exactly one, but we tolerate multiple
 * (e.g. an interim draft followed by the final verdict) by taking the last.
 */
export function findLastStepResult(text: string): StepJudgement | null {
  return text
    .split(/\r?\n/)
    .reduce<StepJudgement | null>((acc, line) => parseStepResultLine(line) ?? acc, null);
}
