import type { ExpandedStep } from "../spec/expand.ts";
import { isExpandedActionStep } from "../spec/expand.ts";
import { fencedBlock } from "./format.ts";
import { languageDirective } from "./language.ts";

/**
 * Asks a reviewer who knows nothing about how the files came to exist whether
 * they would let them into this suite.
 *
 * The generation loop's only bar is "the test goes green", and a rewrite that
 * weakens an assertion clears that bar as easily as one that keeps it. Green
 * therefore does not mean checked, and nothing else looks. Observed cases: a
 * step whose expectation was "the linked page opens" asserting instead that
 * the *link* is still visible on the page it clicked from; another asserting
 * on a navigation element unrelated to the step.
 *
 * The prompt carries paths, not source: the reviewer opens the files itself,
 * which is also what lets it read the rest of the repository. That reading is
 * the point — "follow the existing implementation" is a rule no inline copy of
 * two files can be checked against, because the evidence for it is how many
 * other files do it that way.
 *
 * Nothing here may say, or let the reader infer, that the files were written
 * by a model. A reviewer told that judges the author instead of the code, and
 * the question this asks is what a colleague would say on the pull request.
 */
export function verifiesSpecPrompt(input: {
  steps: readonly ExpandedStep[];
  /** The test under review, as a path the reviewer opens. */
  testPath: string;
  language: string;
  /**
   * What the case states for the flow rather than per step. A markdown case
   * writes them this way, which leaves every step's `expected` empty — so
   * without them there is nothing here to check the test against.
   */
  expectations?: string[];
  /** Cleanup steps, when the case says what its undo must make true. */
  cleanup?: readonly ExpandedStep[];
  /** The other files this change wrote, beside the test. */
  submitted?: readonly string[];
  /** Files already in the repository that the test imports. */
  leansOn?: readonly string[];
  /**
   * The project's own rule documents. Empty when the project declared none:
   * there is then no rule to quote, and the second review below is not asked
   * for at all.
   */
  guides?: readonly { path: string; body: string }[];
}): string {
  const rules = rulesReview(input.guides ?? []);
  return [
    "You are the QA lead who owns this end-to-end suite. A colleague has put the",
    "files below up for review. Open them, read whatever else in the repository you",
    "need in order to judge them, and answer as you would on their pull request.",
    "",
    "## Files under review",
    "",
    "Written by this change:",
    "",
    `- ${input.testPath} (the test)`,
    ...(input.submitted ?? []).map((path) => `- ${path}`),
    "",
    ...(input.leansOn && input.leansOn.length > 0
      ? [
          "Already in the repository, and imported by the test:",
          "",
          ...input.leansOn.map((path) => `- ${path}`),
          "",
        ]
      : []),
    "A path listed here that you cannot open is itself a finding: report every step",
    "that depended on it and name the path, rather than passing over it as if it",
    "were clean.",
    "",
    "## The case this test must cover",
    "",
    "The only statement of what the test has to decide. Not its comments, not its",
    "name, not what the code looks like it is doing.",
    "",
    ...input.steps.map(stepLine),
    "",
    ...(input.expectations && input.expectations.length > 0
      ? [
          "### What the case expects",
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
      ? ["### Cleanup steps", "", ...input.cleanup.map(stepLine), ""]
      : []),
    "## Does the test decide the case",
    "",
    "For each step above, the test must contain assertions that could FAIL if the",
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
    "- the expectation names WHICH screen the run arrives at, and the code",
    "  checks only the address's shape. A pattern matches every screen shaped",
    "  like that one — and screens that are made per category, per folder, per",
    "  account are shaped alike by design, so arriving at the wrong one passes.",
    "  Something the named screen shows has to be checked too;",
    "- it checks that something is ABSENT, and nothing in the test has waited",
    "  for the screen that would show it to finish drawing. Absence is true of",
    "  a page that has not rendered yet, so the check passes on an empty screen",
    "  and passes again when the thing is really there but slow. Something the",
    "  screen shows when it is ready has to be established first;",
    "- the expectation ties two things together — this row AND the count beside",
    "  it, this screen AND what it shows — and the assertions check them apart.",
    "  Read the expectation's own grammar: \"the row, with its count\" is one",
    "  claim about one row, and two assertions that each search the whole page",
    "  hold just as well when the count belongs to a different row. Two things",
    "  the expectation merely lists (\"the heading and the description are",
    "  shown\") are two claims, and checking them apart is right;",
    "- the expectation is about EACH of several things the case names, and the",
    "  assertions reach only one of them. The others are not checked at all, and",
    "  a comment saying they look alike is the fault being written down, not a",
    "  reason — the case asked for each because any one of them can be the one",
    "  that breaks;",
    "- it has no assertion at all.",
    "",
    "An assertion is only as strong as the locator it names, and the locator is",
    "usually not in the test file. Open what the test resolves through, and report",
    "the step when its locator makes the assertion unable to fail the way the",
    "expectation describes. Three shapes to look for:",
    "",
    "- it takes the first (or last) of several matching elements, and the step",
    "  claims something about each of them — the others go unchecked;",
    "- it matches by a string that also appears elsewhere on the page (a nav",
    "  item, a breadcrumb, a menu), so it is satisfied by that element even when",
    "  the one the step names is absent;",
    "- it matches only the words, where the step is about a control — a button,",
    "  a link, a field. Text with that wording is not the control, so the",
    "  assertion holds on a page where the control is gone.",
    "",
    "Judge a locator only through the steps — a definition no step depends on is",
    "not a finding.",
    "",
    "Do NOT report here: style, naming, structure, missing coverage the case never",
    "asked for, or an expectation you merely disagree with. A step that checks",
    "less than you would have written, but still fails when the expectation",
    "breaks, is fine — unless the expectation covers several things and the",
    "code can only break on one of them, which is the bullet above.",
    "",
    ...rules.section,
    "When you have read enough to decide, answer with one json block and nothing",
    "else:",
    "",
    "```json",
    rules.answerShape,
    "```",
    "",
    "`problem` is one sentence naming what the step claims and what the code",
    "checks instead. Empty `findings` means every step is decided.",
    ...rules.answerNote,
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

/**
 * The second review: the same files, read against the rule documents the
 * project wrote and against what the rest of the suite already does.
 *
 * Every rule the generation loop could already check — a type error, a lint
 * rule, a gate of ccqa's own — is followed by the code it produces. A rule
 * that only exists as prose is not, and nothing looked: green, compiled, lint
 * clean and decides its case is the whole bar, and none of it reads the
 * project's own guides. Reused code is the worse half of it — a helper the
 * test imports was written under whatever rules existed when it was written,
 * and no later rule has ever been applied to it.
 *
 * The evidence is what keeps this honest in both directions. A model asked to
 * judge code against prose will find something to say about any code; asked to
 * quote the line it is judging by — or, where the convention is only in the
 * corpus, to say which files it read and how many of them agree — it can only
 * report what is there.
 *
 * Asked once for everything it decides: a project that wrote no rule document
 * gets no section, no second key in the answer, and nothing said about one.
 */
function rulesReview(guides: readonly { path: string; body: string }[]): {
  section: string[];
  answerShape: string;
  answerNote: string[];
} {
  if (guides.length === 0) {
    return {
      section: [],
      answerShape: '{ "findings": [ { "stepId": "step-05", "problem": "…" } ] }',
      answerNote: [],
    };
  }
  return {
    section: [
      "## Does the code belong in this suite",
      "",
      "A second review of the same files, separate from the one above.",
      "",
      "These are the rule documents this project wrote. Report a file when its code",
      "breaks a rule one of them states, and quote the line that states it. The",
      "quote is the check: a rule you cannot quote is a rule the project did not",
      "write, and reporting one of those is as wrong as missing one it did. A",
      "preference of your own is not a rule here, however reasonable.",
      "",
      "How the rest of the suite is written is the other half of this question, and",
      "it is not in the documents: the helper every other case navigates through,",
      "the fixture they all take, where page objects live and what they are called.",
      "Search the repository before you claim one — a convention is what the code",
      "does, not what you would have written — and report it with what you found:",
      "which files you read, and how many of them do it that way.",
      "",
      '"Do NOT report here: style, naming, structure" above governs the step',
      "findings. Those belong in this half instead, and only where a document",
      "states them or the corpus shows them.",
      "",
      "Read what the test leans on, not only what this change wrote. A helper it",
      "imports was written under whatever rules existed then, and nothing has read",
      "it against these since.",
      "",
      ...guides.flatMap((g) => [`### ${g.path}`, "", fencedBlock(g.body), ""]),
    ],
    answerShape:
      '{ "findings": [ { "stepId": "step-05", "problem": "…" } ], "ruleViolations": [ ' +
      '{ "file": "…", "guide": "…", "rule": "…", "code": "…", "severity": "blocking" } ] }',
    answerNote: [
      "",
      "In `ruleViolations`: `file` is the file's path in this repository, and `code`",
      "the lines that break the rule. `guide` and `rule` are where the rule comes",
      "from and what it says — the document's path and its own words when you can",
      "quote one; otherwise the path of a file you read that shows the convention,",
      "and what you counted (\"N of M files under <dir> do X\"). `severity` is",
      '"blocking" when you would hold the change until it is fixed, and "advisory"',
      "when it is worth saying but you would approve anyway. An empty",
      "`ruleViolations` means every file follows every rule you could quote or",
      "count — write the key either way.",
    ],
  };
}
