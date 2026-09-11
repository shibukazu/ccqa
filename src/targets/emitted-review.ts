/**
 * A mechanical read of the code a generation just wrote, before it is called
 * done.
 *
 * The fix loop already runs the project's own test command and checks, so
 * what reaches review is code that compiles, lints and passes. None of that
 * answers whether it is code a reviewer would take: an assertion scoped to
 * nothing passes, a locator named for a row that matches page-wide text
 * passes, a test that checks five things the case never asked about passes.
 * Those are what this reads for, and its findings go back through the same
 * fix loop rather than to a human.
 *
 * Every rule here was calibrated against a real project's hand-written
 * suite: a rule that fires on code people wrote and reviewed is a rule that
 * is wrong, however reasonable it sounds. Two candidates died that way —
 * "a locator named `…Row` must use `getByRole("row")`" fired on a third of
 * the hand-written page objects, because that project names elements for what
 * they look like rather than for their ARIA role, and "never `.first()` in an
 * assertion" fired on three deliberate uses that each carried the comment
 * their own guidelines ask for. A third died against ccqa's own output: the
 * step comment a generated test opens each step with looked like narration,
 * and is what the evidence table reads back to say which assertion belongs to
 * which step. Keep that bar for anything added here.
 */

export interface EmittedFinding {
  /** Project-relative path of the file the finding is in. */
  file: string;
  /** 1-indexed. */
  line: number;
  /** Short, stable id — the fix prompt groups by it. */
  rule: string;
  message: string;
}

export interface EmittedReviewInput {
  /** What this generation wrote: project-relative path → source. */
  files: ReadonlyMap<string, string>;
  /**
   * Everything the case states in its own words — instructions, expectations,
   * cleanup. An assertion naming none of it is asserting something nobody
   * asked for.
   */
  caseText: readonly string[];
}

export function reviewEmittedFiles(input: EmittedReviewInput): EmittedFinding[] {
  const locators = collectLocators(input.files);
  const said = input.caseText.join("\n");
  return [...input.files].flatMap(([file, source]) => [
    ...toolIdentifiers(file, source),
    ...containerOfPageText(file, source),
    ...unjustifiedFirst(file, source),
    ...describeEcho(file, source),
    ...unaskedAssertions(file, source, locators, said),
  ]);
}

const lines = (source: string): string[] => source.split("\n");

/** ccqa's name has no business in a name the project now owns and maintains. */
function toolIdentifiers(file: string, source: string): EmittedFinding[] {
  return lines(source).flatMap((text, i) => {
    const m = /\b(?:const|let|var|readonly)\s+(ccqa[A-Za-z0-9_]*)/i.exec(text);
    return m
      ? [{
          file,
          line: i + 1,
          rule: "tool-identifier",
          message: `\`${m[1]}\` names the tool that wrote it. Name it for what it holds`,
        }]
      : [];
  });
}

const CONTAINER =
  /\b(?:readonly\s+)?([a-zA-Z0-9_]*(?:Row|Cell|Card|Item|List))\s*(?:=\s*|\([^)]*\)\s*:\s*Locator\s*\{\s*(?:return\s+)?)(.*)$/;

/**
 * A name that says "one of the things in a list" built from a match against
 * the whole page. It finds the string anywhere — a heading, a toast, another
 * row — so what it proves is not what its name claims.
 */
function containerOfPageText(file: string, source: string): EmittedFinding[] {
  const all = lines(source);
  return all.flatMap((text, i) => {
    const m = CONTAINER.exec(text);
    if (!m) return [];
    // A method's `return` is on the next line as often as not.
    const body = m[2]!.trim() || (all[i + 1] ?? "").trim().replace(/^return\s+/, "");
    if (!/^this\.page\.getByText\(/.test(body)) return [];
    return [{
      file,
      line: i + 1,
      rule: "unscoped-container",
      message: `\`${m[1]}\` is named for one element among others but matches text anywhere on the page. Scope it to the row/cell it means`,
    }];
  });
}

/**
 * Whether a written reason sits above this line.
 *
 * The comment belongs to the run of assertions it explains, not to each one,
 * so two consecutive checks under one note are one explanation. Both rules
 * that use this are the same rule underneath: an unusual choice is allowed,
 * and has to be said out loud — which is what a project's own guidelines ask
 * of the people writing these by hand.
 */
function explained(all: readonly string[], i: number): boolean {
  let above = i - 1;
  while (above >= 0 && /\bexpect\(|^\s*$|^\s*\)/.test(all[above] ?? "")) above -= 1;
  return /^\s*\/\//.test(all[above] ?? "");
}

/**
 * `.first()` written on an assertion narrows a locator that matched several
 * things, so the assertion holds for whichever came first. Sometimes that is
 * the point — "the newest row is at the top" — and then it is written down.
 *
 * Only where the assertion itself narrows. Following it into the definitions
 * fired on thirty hand-written assertions: a page object that resolves a
 * repeated element once, for every caller, is how that is normally written.
 */
function unjustifiedFirst(file: string, source: string): EmittedFinding[] {
  const all = lines(source);
  return all.flatMap((text, i) => {
    if (!/\bexpect\(/.test(text) || !/\.first\(\)/.test(text)) return [];
    if (explained(all, i)) return [];
    return [{
      file,
      line: i + 1,
      rule: "unjustified-first",
      message: "`.first()` in an assertion holds for whichever element came first. Say why that is the one, or address the element itself",
    }];
  });
}

/** A describe that repeats its only test reads as "X › X" in every report. */
function describeEcho(file: string, source: string): EmittedFinding[] {
  const describe = /test\.describe\(\s*["'](.+?)["']/.exec(source);
  if (!describe) return [];
  const titles = [...source.matchAll(/\n\s*test\(\s*["'](.+?)["']/g)].map((m) => m[1]!);
  if (titles.length !== 1) return [];
  const bare = (s: string): string => s.replace(/\s+@[\w-]+\s*$/, "").trim();
  if (bare(titles[0]!) !== bare(describe[1]!)) return [];
  const line = lines(source).findIndex((t) => t.includes("test.describe(")) + 1;
  return [{
    file,
    line: Math.max(line, 1),
    rule: "describe-echo",
    message: "the describe repeats its only test's name. Drop it, or name the screen the test is about",
  }];
}

/** `name` → the expression it is defined as, across every file written. */
function collectLocators(files: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const source of files.values()) {
    for (const m of source.matchAll(/\breadonly\s+([a-zA-Z0-9_]+)\s*=\s*([^;]+);/g)) {
      out.set(m[1]!, m[2]!);
    }
    for (const m of source.matchAll(/\b([a-zA-Z0-9_]+)\([^)]*\)\s*:\s*Locator\s*\{\s*return\s+([^;]+);/g)) {
      out.set(m[1]!, m[2]!);
    }
  }
  return out;
}

/**
 * The forms that carry a string a person sees on screen. A whitelist, not a
 * blacklist: a test id, an ARIA role name and a CSS selector are all strings
 * too, and none of them is something a test case would ever mention — counted
 * as "what this assertion looks for", every `getByTestId` in a project that
 * prefers them would read as an assertion nobody asked for.
 */
const VISIBLE_STRING =
  /(?:getByText|getByLabel|getByPlaceholder|getByTitle|getByAltText|toHaveText|toContainText|toHaveValue)\(\s*["'`]([^"'`]+)|name:\s*["'`]([^"'`]+)/g;

/**
 * The strings an assertion actually looks for: the ones on its own line plus
 * the ones in whatever page-object members it names.
 */
function expandLocators(text: string, locators: ReadonlyMap<string, string>): string {
  let expanded = text;
  for (const m of text.matchAll(/\.([a-zA-Z0-9_]+)\b/g)) {
    const definition = locators.get(m[1]!);
    if (definition) expanded += `\n${definition}`;
  }
  return expanded;
}

function assertedStrings(text: string, locators: ReadonlyMap<string, string>): string[] {
  return [...expandLocators(text, locators).matchAll(VISIBLE_STRING)]
    .map((m) => (m[1] ?? m[2] ?? "").trim())
    // A value the test composed — a name carrying this run's unique id — is
    // not something a case could have named.
    .filter((s) => s.length > 1 && !s.includes("${"));
}

/**
 * An assertion about something the case never mentions.
 *
 * The case is the contract. Anything else seen along the way adds no
 * coverage, differs between recordings, and is the first thing to break —
 * and a reviewer reading the case cannot tell why the test checks it.
 *
 * Only fires when the assertion looks for a string at all: a URL pattern or
 * a value the test itself computed has nothing to compare against, and
 * silence is the honest answer there. And not when a reason sits above it —
 * checking that a precondition still holds, so the test fails where the
 * precondition broke rather than four steps later, is worth doing and is
 * written down when it is.
 */
function unaskedAssertions(
  file: string,
  source: string,
  locators: ReadonlyMap<string, string>,
  said: string,
): EmittedFinding[] {
  const all = lines(source);
  return all.flatMap((text, i) => {
    if (!/\bexpect\(/.test(text)) return [];
    const strings = assertedStrings(text, locators);
    if (strings.length === 0 || strings.some((s) => said.includes(s))) return [];
    if (explained(all, i)) return [];
    return [{
      file,
      line: i + 1,
      rule: "unasked-assertion",
      message: `nothing in the case asks about ${strings.map((s) => `"${s}"`).join(", ")}. Assert what the case states, and drop the rest`,
    }];
  });
}

/** The findings as the fix loop's other inputs look: a command and its output. */
export function formatEmittedReview(findings: readonly EmittedFinding[]): string {
  return findings
    .map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`)
    .join("\n");
}
