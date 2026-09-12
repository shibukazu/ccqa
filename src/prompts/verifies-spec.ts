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
  /**
   * What the case states for the flow rather than per step. A markdown case
   * writes them this way, which leaves every step's `expected` empty — so
   * without them there is nothing here to check the test against.
   */
  expectations?: string[];
  /** Cleanup steps, when the case says what its undo must make true. */
  cleanup?: readonly ExpandedStep[];
  /**
   * The page objects and helpers the test leans on. An assertion is only as
   * strong as the locator it names, and the locator is usually not in the test
   * file — a reviewer opens both, so this review reads both.
   */
  support?: readonly { path: string; source: string }[];
}): string {
  return [
    "You are reviewing whether a generated end-to-end test decides what its spec says.",
    "",
    "For each step below, the test must contain assertions that could FAIL if the",
    "step's `expected` stopped holding. Report a step when:",
    "",
    "- its assertions cannot fail while the product is broken in the way the",
    "  expectation describes — because they check something weaker than it",
    "  states (the expectation says a page opens and the code re-checks the",
    "  element it clicked; the expectation names a path with an id in it and the",
    "  pattern also matches the path without one);",
    "- what it asserts on is unrelated to what the step did (e.g. a navigation",
    "  element that is present on every page);",
    "- it depends on something that varies between runs and is not part of the",
    "  expectation (a count, an index, a position, wording that changes);",
    "- it checks that something is ABSENT, and nothing in the test has waited",
    "  for the screen that would show it to finish drawing. Absence is true of",
    "  a page that has not rendered yet, so the check passes on an empty screen",
    "  and passes again when the thing is really there but slow. Something the",
    "  screen shows when it is ready has to be established first;",
    "- the expectation is about EACH of several things the case names, and the",
    "  assertions reach only one of them. The others are not checked at all, and",
    "  a comment saying they look alike is the fault being written down, not a",
    "  reason — the case asked for each because any one of them can be the one",
    "  that breaks;",
    "- it has no assertion at all.",
    "",
    "Do NOT report: style, naming, structure, missing coverage the spec never",
    "asked for, or an expectation you merely disagree with. A step that checks",
    "less than you would have written, but still fails when the expectation",
    "breaks, is fine — unless the expectation covers several things and the",
    "code can only break on one of them, which is the bullet above.",
    "",
    "## Steps",
    "",
    ...input.steps.map(stepLine),
    "",
    ...(input.expectations && input.expectations.length > 0
      ? [
          "## What the case expects",
          "",
          "Stated for the flow, not per step. Each belongs to the step that first",
          "makes it true; a step is unchecked when nothing decides the one that",
          "belongs to it.",
          "",
          ...input.expectations.map((e) => `- ${e}`),
          "",
        ]
      : []),
    ...(input.cleanup && input.cleanup.length > 0
      ? ["## Cleanup steps", "", ...input.cleanup.map(stepLine), ""]
      : []),
    "## Generated test",
    "",
    "```",
    input.source,
    "```",
    "",
    ...(input.support && input.support.length > 0
      ? [
          "## What it leans on",
          "",
          "The locators the assertions above resolve through. An assertion is",
          "only as strong as its locator, so read them, and report the step when",
          "its locator makes the assertion unable to fail the way the",
          "expectation describes. Two shapes to look for:",
          "",
          "- it takes the first (or last) of several matching elements, and the",
          "  step claims something about each of them — the others go unchecked;",
          "- it matches by a string that also appears elsewhere on the page (a",
          "  nav item, a breadcrumb, a menu), so it is satisfied by that element",
          "  even when the one the step names is absent;",
          "- it matches only the words, where the step is about a control — a",
          "  button, a link, a field. Text with that wording is not the control,",
          "  so the assertion holds on a page where the control is gone.",
          "",
          "Judge these only through the steps — a definition no step depends on",
          "is not a finding.",
          "",
          ...input.support.flatMap((f) => [`### ${f.path}`, "", "```", f.source, "```", ""]),
        ]
      : []),
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
