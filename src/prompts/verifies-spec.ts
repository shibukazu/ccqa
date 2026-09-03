import type { ExpandedStep } from "../spec/expand.ts";
import { isExpandedActionStep } from "../spec/expand.ts";
import { languageDirective } from "./language.ts";

/**
 * Asks whether a generated test actually decides what its spec claims.
 *
 * The generation loop's only bar is "the test goes green", and a rewrite that
 * weakens an assertion clears that bar as easily as one that keeps it. Green
 * therefore does not mean checked, and nothing else looks. Observed cases: a
 * step whose expectation was "the linked page opens" asserting instead that
 * the *link* is still visible on the page it clicked from; another asserting
 * on a navigation element unrelated to the step.
 *
 * Deliberately narrow. It reads only what the step says and what the code
 * does, and reports the step as unchecked when the two do not line up. It
 * does not review style, coverage, or whether the expectation is a good one.
 */
export function verifiesSpecPrompt(input: {
  steps: readonly ExpandedStep[];
  source: string;
  language: string;
}): string {
  return [
    "You are reviewing whether a generated end-to-end test decides what its spec says.",
    "",
    "For each step below, the test must contain assertions that could FAIL if the",
    "step's `expected` stopped holding. Report a step when:",
    "",
    "- its assertions cannot fail while the product is broken in the way the",
    "  expectation describes (e.g. the expectation says a page opens, and the",
    "  code only re-checks the element it clicked);",
    "- what it asserts on is unrelated to what the step did (e.g. a navigation",
    "  element that is present on every page);",
    "- it depends on something that varies between runs and is not part of the",
    "  expectation (a count, an index, a position, wording that changes);",
    "- it has no assertion at all.",
    "",
    "Do NOT report: style, naming, structure, missing coverage the spec never",
    "asked for, or an expectation you merely disagree with. A step that checks",
    "less than you would have written, but still fails when the expectation",
    "breaks, is fine.",
    "",
    "## Steps",
    "",
    ...input.steps.map(stepLine),
    "",
    "## Generated test",
    "",
    "```",
    input.source,
    "```",
    "",
    "Answer with one json block and nothing else:",
    "",
    "```json",
    '{ "findings": [ { "stepId": "step-05", "problem": "…" } ] }',
    "```",
    "",
    "`problem` is one sentence naming what the step claims and what the code",
    "checks instead. Empty `findings` means every step is decided.",
    languageDirective(input.language),
  ].join("\n");
}

function stepLine(step: ExpandedStep): string {
  if (!isExpandedActionStep(step)) {
    return `- ${step.id}: judged by a model at run time — its claim is asserted by the injected call, so it needs no other assertion.`;
  }
  return [
    `- ${step.id}`,
    `  does: ${oneLine(step.instruction)}`,
    `  expected: ${oneLine(step.expected)}`,
  ].join("\n");
}

function oneLine(text: string): string {
  return text.trim().split("\n").map((l) => l.trim()).join(" ");
}
