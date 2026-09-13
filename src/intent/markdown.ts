import type { IntentFields } from "../config/project-config.ts";

/**
 * A test case written as markdown, read through the project's own headings.
 *
 * The shape here is ccqa's; the headings are the project's. A repository that
 * already keeps its manual test cases as markdown keeps writing them the way
 * it does — `intent.fields` says which heading means what, and nothing about
 * that repository's vocabulary reaches this module.
 *
 * What the format asks of a case is only this: the steps are a numbered list,
 * so a step can be referred to by its number for the rest of its life, and
 * anything else is prose ccqa passes on rather than parses.
 */

/** One numbered step, as the case's author wrote it. */
export interface IntentStep {
  /** Its position in the list, as a reader counts it — what evidence cites. */
  number: number;
  text: string;
}

export interface IntentCase {
  /** Path below the intent root, without the extension. Also `{case}`. */
  id: string;
  title: string;
  steps: IntentStep[];
  /**
   * What the case says must be true, as its author listed it — not yet
   * attached to any step. Which step decides which expectation is a reading of
   * the flow, so it is the recorder's to make (see the trace prompt), not a
   * parser's.
   */
  expected: string[];
  /** Steps to run after the case, whatever its outcome. */
  cleanup: IntentStep[];
  /**
   * What the cleanup itself must make true — the confirmation a case writes
   * under its teardown ("the item is gone from the list"). Kept apart from
   * `expected`, which is about the flow: these are decided in `afterEach`,
   * where the undo happens, and asserting them among the case's own steps
   * would check them before the undo ran.
   */
  cleanupExpected: string[];
  priority?: string;
  /** The mode section's first line, verbatim. Absent when unnamed or blank. */
  mode?: string;
  /** Where the case came from, for the generated test's header. */
  link: { url?: string; ref?: string };
  /**
   * Every heading the field map does not name, in source order. The
   * precondition is one of these on purpose: it is context for the recorder,
   * not a thing ccqa acts on.
   */
  other: Array<{ heading: string; body: string }>;
  /** Headings and bodies verbatim, so a write-back can find its section. */
  sections: Array<{ heading: string; body: string }>;
}

/** A heading and its body, as `##` sections divide the file. */
interface Section {
  heading: string;
  body: string;
}

/**
 * Split on level-2 headings. Deeper headings belong to the section they sit
 * in — a case that structures its steps with `###` is still one case.
 */
export function splitSections(source: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of source.split(/\r?\n/)) {
    const heading = /^##\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { heading: heading[1]!, body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, body: s.body.trim() }));
}

/**
 * `1. text`, `1) text`, `1．text`, at the start of a line.
 *
 * The indent is bounded to three spaces because deeper means a nested list —
 * a sub-item of the step above, not a step. And the literal digits are not the
 * step's number: markdown lets every item be written `1.` and leaves the
 * counting to the renderer, so ccqa counts the same way a reader does.
 */
const NUMBERED = /^ {0,3}(\d+)\s*[.)．]\s*(.+)$/;
/** `- text`, `* text`, `・text` — the bullet characters people actually use. */
const BULLET = /^\s*(?:[-*+]|・)\s*(.+)$/;

function numberedItems(body: string): IntentStep[] {
  const steps: IntentStep[] = [];
  for (const line of body.split("\n")) {
    const m = NUMBERED.exec(line);
    if (m) steps.push({ number: steps.length + 1, text: m[2]!.trim() });
    // A line that continues the step it follows, indented under it.
    else if (steps.length > 0 && /^\s+\S/.test(line)) {
      const last = steps[steps.length - 1]!;
      last.text = `${last.text} ${line.trim()}`;
    }
  }
  return steps;
}

/**
 * A section written as a list, or as a paragraph.
 *
 * The list form is the useful one — each item is placed against the step that
 * makes it true — but a case whose author wrote a sentence has still stated an
 * expectation, and dropping it because of its punctuation would be ccqa losing
 * what the case says. So prose is one item, and nothing is lost either way.
 */
function listOrProse(body: string): string[] {
  const items = bulletItems(body);
  if (items.length > 0) return items;
  const prose = body.trim();
  return prose.length > 0 ? [prose] : [];
}

/** Cleanup, likewise: numbered when numbered, otherwise the paragraph as one step. */
function cleanupSteps(body: string): IntentStep[] {
  const numbered = numberedItems(body);
  if (numbered.length > 0) return numbered;
  const prose = body.trim();
  return prose.length > 0 ? [{ number: 1, text: prose }] : [];
}

/** `- text` at the left margin — not an indented bullet, which continues the step above it. */
const TOP_LEVEL_BULLET = /^ {0,3}(?:[-*+]|・)\s*(.+)$/;

/**
 * What a cleanup section says besides its steps. A case that numbers its
 * teardown and then lists what should be true afterwards is stating two
 * different things under one heading, and only the numbered half is a step.
 * An unnumbered section is prose the whole way down and states no separate
 * expectation.
 */
function cleanupExpectations(body: string): string[] {
  if (numberedItems(body).length === 0) return [];
  return body
    .split("\n")
    .map((line) => TOP_LEVEL_BULLET.exec(line)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text.length > 0);
}

function bulletItems(body: string): string[] {
  return body
    .split("\n")
    .map((line) => BULLET.exec(line)?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text.length > 0);
}

/**
 * A labelled bullet's value: `URL: https://…` / `URL：https://…`. Both colons,
 * because a case written in Japanese uses the full-width one and nobody should
 * have to think about it.
 */
function labelled(items: string[], label: string): string | undefined {
  for (const item of items) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(item);
    if (m && m[1]!.trim().toLowerCase() === label.toLowerCase()) {
      const value = m[2]!.trim();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

export interface ParseMarkdownCaseInput {
  /** Case id: the path below the intent root, without the extension. */
  id: string;
  source: string;
  fields: IntentFields;
}

/**
 * Read one markdown file as a case. A heading the field map names becomes that
 * field; everything else is carried through untouched. The only hard
 * requirement is a numbered list of steps: a case with none describes nothing
 * to record, and failing here beats a recording of nothing.
 */
export function parseMarkdownCase(input: ParseMarkdownCaseInput): IntentCase {
  const { fields } = input;
  const sections = splitSections(input.source);
  const named = new Map(sections.map((s) => [s.heading, s]));
  const body = (heading: string): string => named.get(heading)?.body ?? "";

  const steps = numberedItems(body(fields.steps));
  if (steps.length === 0) {
    throw new Error(
      `${input.id}: no steps — the "${fields.steps}" section must hold a numbered list of what to do`,
    );
  }
  const linkItems = bulletItems(body(fields.link));
  // The precondition is deliberately not claimed: ccqa does nothing with it,
  // and what it holds — which account to sign in as, what must already exist —
  // is exactly what whoever runs the case needs to read.
  const claimed = new Set(Object.values({ ...fields, precondition: "" }));
  claimed.delete("");
  const title = body(fields.title).trim();

  return {
    id: input.id,
    // A case with no title section is named by its own path, which is what a
    // reader recognises it by anyway.
    title: title.length > 0 ? firstLine(title) : input.id,
    steps,
    expected: listOrProse(body(fields.expected)),
    cleanup: cleanupSteps(body(fields.cleanup)),
    cleanupExpected: cleanupExpectations(body(fields.cleanup)),
    ...(body(fields.priority) ? { priority: firstLine(body(fields.priority)) } : {}),
    ...(fields.mode && body(fields.mode) ? { mode: firstLine(body(fields.mode)) } : {}),
    link: {
      ...(labelled(linkItems, "url") ? { url: labelled(linkItems, "url") } : {}),
      ...(labelled(linkItems, "no") ? { ref: labelled(linkItems, "no") } : {}),
    },
    other: sections.filter((s) => !claimed.has(s.heading) && s.body.length > 0),
    sections,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}

/**
 * The same file with one section's body replaced, and every other byte left
 * alone. Used to write a generated test's path back into the case that asked
 * for it — a case file is the project's, and ccqa rewrites exactly the line it
 * was given permission to.
 */
export function replaceSectionBody(source: string, heading: string, body: string): string | null {
  // The file's own line ending, kept: rewriting one section must not rewrite
  // every line of a CRLF-authored file in the project's next diff.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+(.*\S)\s*$/.exec(line)?.[1] === heading);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end]!)) end++;
  // Keep the blank lines that separated the section from the next heading, so
  // a write-back never reflows the document around it. When the section runs
  // to the end of the file, the slice below already carries the file's final
  // empty line — appending another grows the case file by one blank line on
  // every generate, in the one file ccqa promised to touch minimally.
  let tail = end;
  while (tail > start + 1 && lines[tail - 1]!.trim() === "") tail--;
  const rest = lines.slice(tail);
  return [...lines.slice(0, start + 1), "", body, ...(rest.length > 0 ? rest : [""])].join(eol);
}
