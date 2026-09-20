import type { StepMarker } from "./actions-to-script.ts";
import { cleanupId, stepId } from "../cases/case.ts";

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

/**
 * `step: step-01 [case]` — the identifier form, for a `spec.yaml` step.
 *
 * Anchored, and the bracket is read only as part of it: a cited step's text is
 * prose, and prose holds brackets of its own ("click the [Save] button") that
 * would otherwise be read as the step's source.
 */
const ID_FORM = /^\s*step:\s*(\S+?)\s*\[([^\]]+)\]/;
/** `step 1: <text>` / `cleanup 1: <text>` — the English cited form. */
const CITED_EN = /^\s*(step|cleanup)\s+(\d+)\s*:/;
/** `1. <text>` / `後処理 1. <text>` — the Japanese cited form. */
const CITED_JA = /^\s*(後処理\s*)?(\d+)\s*[.．]\s/;
/**
 * `await test.step("step 1: ...", async () => {` — the label as a step title.
 *
 * The title is the same label the comment form carries, so both are read by
 * the one parser below. The quote is captured and required back so an
 * apostrophe inside the title cannot end it early. Global so it can be run
 * over a whole file; `matchAll` and `replace` both leave `lastIndex` alone, so
 * the single instance is safe to share.
 */
const STEP_CALL = /\btest\.step\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

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
  return `// ${renderStepLabel(marker, japanese)}`;
}

/**
 * The same label without the comment marker, for a `test.step` title.
 *
 * One renderer for both placements: the title is what the Playwright report
 * shows and what the evidence table reads back, and a second wording would
 * mean a test whose report and whose table disagree about a step's name.
 */
export function renderStepLabel(
  marker: Pick<StepMarker, "stepId" | "source" | "text">,
  japanese = false,
): string {
  const number = CASE_SOURCES.has(marker.source) ? stepNumber(marker.stepId) : null;
  const text = marker.text?.trim().split("\n")[0]?.trim();
  if (number === null || !text) return `step: ${marker.stepId} [${marker.source}]`;
  const isCleanup = marker.source === "cleanup";
  if (japanese) return `${isCleanup ? "後処理 " : ""}${number}. ${text}`;
  return `${isCleanup ? "cleanup" : "step"} ${number}: ${text}`;
}

/**
 * The step id a line opens, or null when it opens none. Both placements are
 * accepted — a `test.step` title for a Playwright test, a comment for the
 * agent-browser emitter and for every test generated before the titles.
 */
export function parseStepComment(line: string): string | null {
  const block = parseStepBlock(line);
  if (block !== null) return block;
  const comment = /^\s*\/\/\s*(.*)$/.exec(line);
  return comment ? (parseStepLabel(comment[1]!)?.stepId ?? null) : null;
}

/**
 * A file's lines, with a `test.step` header a formatter broke across lines
 * folded back onto the line it opens.
 *
 * Both readers of a step boundary walk lines — the evidence table attributes
 * the assertions under one, the generation gate collects the ids a file titles
 * — and neither can see a call whose title sits on the next line. Prettier
 * wraps `test.step` like any other call (it is not in its test-call
 * allowlist), and a line walk over the wrapped form finds no steps at all:
 * every step then reads as deciding nothing and every rewrite is rejected.
 */
export function stepLines(source: string): string[] {
  return source.replace(STEP_CALL, (call) => call.replace(/\s*\n\s*/g, " ")).split("\n");
}

/**
 * The step id a `test.step` title names — the block form only.
 *
 * Split out from {@link parseStepComment} because reading and writing want
 * different strictness. Anything ccqa has ever generated has to stay readable,
 * so attribution accepts the comment form too; a file ccqa writes today has no
 * reason to be in it, so the generation gate asks this narrower question and
 * rejects a rewrite that fell back to comments.
 */
export function parseStepBlock(line: string): string | null {
  const [call] = line.matchAll(STEP_CALL);
  return call ? (parseStepLabel(call[2]!)?.stepId ?? null) : null;
}

/** What a rendered label names: the step it opens, and the document it came from. */
export interface StepLabel {
  stepId: string;
  source: string;
}

/**
 * The step a rendered label names, or null when it names none — the single
 * inverse of {@link renderStepLabel}, wherever a label is read back from: a
 * comment, a `test.step` title in the file, or the same title as a Playwright
 * trace recorded it.
 */
export function parseStepLabel(label: string): StepLabel | null {
  const byId = ID_FORM.exec(label);
  if (byId) return { stepId: byId[1]!, source: byId[2]! };
  const en = CITED_EN.exec(label);
  if (en) return labelFor(en[1] === "cleanup", Number.parseInt(en[2]!, 10));
  const ja = CITED_JA.exec(label);
  if (ja) return labelFor(ja[1] !== undefined, Number.parseInt(ja[2]!, 10));
  return null;
}

/** Built by the same functions that named the step, so the two cannot drift. */
function labelFor(cleanup: boolean, number: number): StepLabel {
  return cleanup
    ? { stepId: cleanupId(number), source: "cleanup" }
    : { stepId: stepId(number), source: "case" };
}
