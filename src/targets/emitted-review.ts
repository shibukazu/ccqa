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
  /** The case's own generated test, by the path the project configured for it. */
  testPath: string;
  /**
   * Per emitted file, the identifiers the project's own test assets mention —
   * counting only the files that could be talking about *this* one. Absent
   * when the caller did not look.
   *
   * It answers the one question that makes "nothing uses this" safe to say. A
   * page object exists to be shared, so a definition this generation does not
   * reach may still be another case's — unless nobody's.
   *
   * Scoped per file because property names are not unique across a suite:
   * `deleteSuccessToast` sits on four unrelated page objects in one real
   * project, so a flat set of every identifier answers "somebody uses that
   * word" and never "somebody reaches this property".
   */
  usedInProject?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function reviewEmittedFiles(input: EmittedReviewInput): EmittedFinding[] {
  const locators = collectLocators(input.files);
  const said = input.caseText.join("\n");
  return [
    ...decidesNothing(input),
    ...unassertedPath(input),
    ...[...input.files].flatMap(([file, source]) => [
      ...toolIdentifiers(file, source),
      ...containerOfPageText(file, source),
      ...unjustifiedFirst(file, source),
      ...describeEcho(file, source),
      ...unaskedAssertions(file, source, locators, said),
      ...weakerTwin(file, source),
      ...unreached(file, source, input),
    ]),
  ];
}

/**
 * A path with a placeholder segment in it — `/orders/{orderId}`. Writing one
 * in prose is a statement about the address, not about the page's contents:
 * there is no other reason to name the part that changes per run.
 */
const PLACEHOLDER_PATH = /\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*\/\{[A-Za-z0-9_]+\}/;

/**
 * A case that says where the run must end up, and a test that never looks at
 * the address.
 *
 * The row being on screen is not the same claim as being on the screen that
 * shows it — a product that rendered the row without navigating passes, and
 * that is the failure the expectation was written to catch. Scoped to
 * placeholder paths because those are unambiguous; a path mentioned as scenery
 * ("on /settings, the button is shown") is not a claim about the address.
 *
 * Calibrated against the 20 case definitions of a real project: three name a
 * placeholder path in their expectations, two of those already assert on the
 * URL, and the one that does not is the defect this was written for.
 */
function unassertedPath(input: EmittedReviewInput): EmittedFinding[] {
  const source = input.files.get(input.testPath);
  if (source === undefined) return [];
  const stated = input.caseText.find((text) => PLACEHOLDER_PATH.test(text));
  if (stated === undefined || /\btoHaveURL\b/.test(source)) return [];
  return [{
    file: input.testPath,
    line: 1,
    rule: "unasserted-path",
    message:
      `the case says where the run ends up — "${PLACEHOLDER_PATH.exec(stated)?.[0]}" — and nothing ` +
      "here looks at the address. What the screen shows can be right while the screen is wrong. " +
      "Assert the URL where the case says it changes",
  }];
}

/** `readonly name =`, `name(...): Locator {`, and `export … name`. */
const DECLARED = /(?:readonly\s+([A-Za-z0-9_]+)\s*=|\b([A-Za-z0-9_]+)\([^)]*\)\s*:\s*Locator\b|export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z0-9_]+))/g;

/**
 * A definition in a file this generation wrote that nothing reaches — not the
 * test it generated, and not the project's own test assets either.
 *
 * Both halves are needed. Without the first it is not this generation's
 * business; without the second every shared definition another case uses would
 * be reported. Together they say only what is true: nobody reaches this.
 */
function unreached(
  file: string,
  source: string,
  input: EmittedReviewInput,
): EmittedFinding[] {
  const elsewhere = input.usedInProject?.get(file);
  if (elsewhere === undefined) return [];
  // Its own file included: a property one method of the same page object
  // reaches is used. The declaration itself is discounted per name below.
  const corpus = [...input.files.values()].join("\n");
  return lines(source).flatMap((text, i) => {
    const declared = DECLARED.exec(text);
    DECLARED.lastIndex = 0;
    if (!declared) return [];
    const name = named(declared);
    if (!name || elsewhere.has(name)) return [];
    const uses = corpus.split(new RegExp(`\\b${name}\\b`)).length - 1;
    if (uses > 1) return [];
    return [{
      file,
      line: i + 1,
      rule: "unreached",
      message: `\`${name}\` is defined here and nothing reaches it — not this case's test, and nothing else in the project. Remove it`,
    }];
  });
}

const named = (m: RegExpMatchArray): string => m[1] ?? m[2] ?? m[3] ?? "";

/**
 * Two names for one visible string, where one of them is strictly weaker: a
 * role and its accessible name next to a bare page-wide text match that then
 * picks a position out of the matches.
 *
 * The weak one adds no check — anything it could catch, the other catches
 * first — and it is satisfied by whichever element the page happens to order
 * first, which on a real page was the navigation entry rather than the heading
 * the case names. Both assertions then read as two checks and are one.
 *
 * Calibrated against 214 hand-written page objects in a real suite: the shape
 * appears once, in a file a generation wrote. People do not write it.
 */
function weakerTwin(file: string, source: string): EmittedFinding[] {
  const byString = new Map<string, { name: string; line: number; weak: boolean }[]>();
  lines(source).forEach((text, i) => {
    const declared = /(?:readonly|const)\s+([A-Za-z0-9_]+)\s*=\s*(.+?);\s*$/.exec(text);
    if (!declared) return;
    const [, name, expression] = declared as unknown as [string, string, string];
    const weak = /\.(?:first|last|nth)\(/.test(expression) && expression.includes("getByText(");
    const strong = expression.includes("getByRole(") && !/\.(?:first|last|nth)\(/.test(expression);
    if (!weak && !strong) return;
    for (const m of expression.matchAll(VISIBLE_STRING)) {
      const value = m[1] ?? m[2];
      if (!value || value.includes("${")) continue;
      const seen = byString.get(value) ?? [];
      seen.push({ name, line: i + 1, weak });
      byString.set(value, seen);
    }
  });
  const findings: EmittedFinding[] = [];
  for (const [value, defs] of byString) {
    const weak = defs.filter((d) => d.weak);
    if (weak.length === 0 || defs.every((d) => d.weak)) continue;
    const strong = defs.find((d) => !d.weak)!;
    for (const d of weak) {
      findings.push({
        file,
        line: d.line,
        rule: "weaker-twin",
        message:
          `\`${d.name}\` and \`${strong.name}\` are both "${value}", and this one searches the ` +
          `whole page and takes a position out of the matches. It can only be satisfied by ` +
          `something \`${strong.name}\` already covers, or by the wrong element. Assert one of them`,
      });
    }
  }
  return findings;
}

/**
 * A test with no assertion anywhere in it, for a case that states something.
 *
 * The per-step version of this question belongs to the reading, which knows
 * that "open the list" claims nothing and expects no assertion under it. This
 * one needs no judgement: whatever the case says, a file that decides nothing
 * at all does not check it. It is the floor under a case whose expectations
 * are stated for the flow rather than per step — the shape a markdown case has
 * — where the reading is otherwise the only thing looking.
 *
 * Calibrated like the rest: of 546 hand-written specs in a real suite, none
 * has zero assertions.
 */
function decidesNothing(input: EmittedReviewInput): EmittedFinding[] {
  const source = input.files.get(input.testPath);
  if (source === undefined || input.caseText.join("").trim().length === 0) return [];
  if (/\bexpect\(|\bjudgeByLlm\b/.test(source)) return [];
  return [{
    file: input.testPath,
    line: 1,
    rule: "decides-nothing",
    message:
      "this test contains no assertion at all, so it passes whatever the product does. " +
      "Decide what the case says must be true",
  }];
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

/**
 * Searching the whole page for something a name calls a container: its text,
 * or a structural tag that says nothing about what the element is.
 *
 * Both forms, because the first version tested only `getByText` and the fix
 * pass answered it with `page.locator("div").filter({ hasText }).last()` —
 * the same page-wide search, now resting on DOM order, and invisible to a
 * rule that only knew one shape. A generation that escapes a finding by
 * changing shape is worse than one that never drew it.
 */
const PAGE_ROOTED = /^this\.page\.(?:getByText\(|locator\(["'](?:div|span|p|li|ul|ol|section|article)["']\))/;

const CONTAINER =
  /\b(?:readonly\s+)?([a-zA-Z0-9_]*(?:Row|Cell|Card|Item|List))\s*(?:=\s*|\([^)]*\)\s*:\s*Locator\s*\{\s*(?:return\s+)?)(.*)$/;

/**
 * A name that says "one of the things in a list" built from a match against
 * the whole page. It finds the string anywhere — a heading, a toast, another
 * row — so what it proves is not what its name claims.
 *
 * The message names the shapes that fix it, because the first version said
 * only "scope it" and the fix pass answered with `page.locator("div")` filtered
 * by the same text and narrowed with `.last()` — page-wide still, and now
 * resting on which match the DOM happens to put last.
 */
function containerOfPageText(file: string, source: string): EmittedFinding[] {
  const all = lines(source);
  return all.flatMap((text, i) => {
    const m = CONTAINER.exec(text);
    if (!m) return [];
    // A method's `return` is on the next line as often as not.
    const body = m[2]!.trim() || (all[i + 1] ?? "").trim().replace(/^return\s+/, "");
    if (!PAGE_ROOTED.test(body)) return [];
    return [{
      file,
      line: i + 1,
      rule: "unscoped-container",
      message:
        `\`${m[1]}\` is named for one element among others, but matches that text anywhere on the page — ` +
        `a heading or a toast carrying it satisfies this too. Address the element itself: the role it has ` +
        `(\`getByRole("row"|"listitem"|"article"|...)\` narrowed with \`.filter({ hasText })\`), or its test id. ` +
        `Where the page offers neither, scope from a container this page object already addresses — ` +
        `searching the whole page for a bare \`div\` and taking \`.first()\`/\`.last()\` is not scoping, ` +
        `it only picks whichever the DOM happens to order that way.`,
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
