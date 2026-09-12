import type { StepMarker } from "./actions-to-script.ts";
import { cleanupId, stepId } from "../intent/case.ts";

/**
 * The comment that opens a step in generated code, and the reader that finds
 * it again.
 *
 * A reviewer's question is "does this code do what the case says", and the
 * answer is easiest when the code quotes the case. So a step whose text came
 * from a document the project wrote — a markdown case — is commented with its
 * own number and sentence, and everything else keeps the identifier form the
 * agent-browser emitter has always used.
 *
 * Rendering and parsing live together because they have to agree: the
 * evidence table reads these comments back to say which assertion belongs to
 * which step, and a format that only one side knew would silently produce a
 * table with every row empty.
 */

/** `// step: step-01 [case]` — the identifier form, for a `spec.yaml` step. */
const ID_FORM = /^\s*\/\/\s*step:\s*(\S+)\s*\[/;
/** `// step 1: <text>` / `// cleanup 1: <text>` — the English cited form. */
const CITED_EN = /^\s*\/\/\s*(step|cleanup)\s+(\d+)\s*:/;
/** `// 1. <text>` / `// 後処理 1. <text>` — the Japanese cited form. */
const CITED_JA = /^\s*\/\/\s*(後処理\s*)?(\d+)\s*[.．]\s/;

/** Sources whose steps come from the project's own case document. */
const CASE_SOURCES = new Set(["case", "cleanup"]);

/** `step-03` → 3; `cleanup-01` → 1. Absent when the id is not numbered. */
function stepNumber(stepId: string): number | null {
  const m = /-(\d+)$/.exec(stepId);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * The comment for one step. `japanese` picks the cited form's wording; it has
 * no effect on a `spec.yaml` step, whose comment is an identifier either way.
 */
export function renderStepComment(
  marker: Pick<StepMarker, "stepId" | "source" | "text">,
  japanese = false,
): string {
  const number = CASE_SOURCES.has(marker.source) ? stepNumber(marker.stepId) : null;
  const text = marker.text?.trim().split("\n")[0]?.trim();
  if (number === null || !text) return `// step: ${marker.stepId} [${marker.source}]`;
  const isCleanup = marker.source === "cleanup";
  if (japanese) return `// ${isCleanup ? "後処理 " : ""}${number}. ${text}`;
  return `// ${isCleanup ? "cleanup" : "step"} ${number}: ${text}`;
}

/** The step id a comment line names, or null when the line is not one. */
export function parseStepComment(line: string): string | null {
  const byId = ID_FORM.exec(line);
  if (byId) return byId[1]!;
  const en = CITED_EN.exec(line);
  if (en) return idFor(en[1] === "cleanup", Number.parseInt(en[2]!, 10));
  const ja = CITED_JA.exec(line);
  if (ja) return idFor(ja[1] !== undefined, Number.parseInt(ja[2]!, 10));
  return null;
}

/** Built by the same functions that named the step, so the two cannot drift. */
function idFor(cleanup: boolean, number: number): string {
  return cleanup ? cleanupId(number) : stepId(number);
}
