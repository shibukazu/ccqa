import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { SourceRoot } from "../config/source-roots.ts";

/**
 * A mechanical stand-in for a reviewer grepping the product's source by hand:
 * exact substring, no LLM. The evidence table asks it "does this locator value
 * appear anywhere in the source" and gets a file:line, an honest "not found",
 * or — when several places say it equally well — both of them.
 *
 * The first match is not the answer. A string a screen renders also appears in
 * the document that specified the screen, in the script that seeded it, and in
 * a comment somewhere; taking whichever the walk reached first pointed
 * reviewers at design docs and seed data. So candidates are ranked by what
 * kind of file and line they are, and only the best rank is reported.
 */

/** What a needle is, which decides how a line may match it. */
export interface SourceNeedle {
  value: string;
  /** `testid` matches only as a test-id attribute's value; `text` matches anywhere. */
  kind: "testid" | "text";
}

export interface SourceAnchor {
  /** The string that was searched for. */
  needle: string;
  /**
   * The best-ranked places it was found, as `path:line` under the root as
   * configured. More than one means the answer is not decided — a count is
   * not offered, because the scan stops once it has the two the table shows
   * and would otherwise be reporting a tally it did not finish.
   */
  places: string[];
  /**
   * The string was only ever found glued inside a longer one. Still reported,
   * because a locator that matches by substring is a locator that works — but
   * said out loud, because "the product renders this" is not what was found.
   */
  partial?: boolean;
}

export interface SourceAnchors {
  found: Map<string, SourceAnchor>;
  /**
   * Needles this never looked for, or stopped looking for. An unresolved
   * needle in here means "not looked at", not "not there", and the two must
   * not be shown the same way — the whole value of the column is that
   * "not found" is a fact about the product.
   */
  unsearched: Set<string>;
}

/**
 * Files that render what a person sees: components and server-side templates.
 * The best kind of answer this scan can give, because a string found in one is
 * a string the product puts on a screen.
 */
const UI_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".htm",
  ".erb", ".haml", ".slim", ".twig", ".blade", ".liquid", ".hbs", ".ejs", ".mustache",
  ".jsp", ".cshtml", ".razor", ".templ",
]);

/**
 * Files that may hold the string without rendering it: the rest of the
 * application's code. A hit here is real but weaker — it is as likely to be a
 * constant, a log line or a route name as the copy the case means.
 */
const CODE_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".php", ".rb", ".py", ".go", ".java", ".kt", ".cs", ".rs", ".ex", ".exs",
]);

/** Read only under a translations directory, where they are the copy itself. */
const MESSAGE_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".properties", ".po", ".arb"]);

/** Path segments that mean a translation catalogue. */
const MESSAGE_DIRS = new Set(["i18n", "intl", "locale", "locales", "lang", "langs", "messages", "translations"]);

/**
 * Path segments whose files are about the product rather than part of it. A
 * hit under one of these is dropped, not ranked last: "not found" is a claim
 * about what the product renders, and a specification or a seed script renders
 * nothing.
 */
const NOT_THE_PRODUCT = new Set([
  "doc", "docs", "documentation", "adr", "rfc",
  "script", "scripts", "seed", "seeds", "migration", "migrations",
  "test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "playwright",
  "fixture", "fixtures", "mock", "mocks", "__mocks__", "stories", "storybook",
  "example", "examples", "sample", "samples",
]);

/** Directory names that are never a product's own UI source. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Best first: a UI file beats a translation catalogue, which beats any other code. */
const RANK_UI = 3;
const RANK_MESSAGES = 2;
const RANK_CODE = 1;
/** Not part of the product, or the line is a comment. Never reported. */
const RANK_NONE = 0;

function segments(relPath: string): string[] {
  return relPath.split(/[\\/]+/);
}

/** How much a file found in `relPath` is worth as evidence, before the line is read. */
function rankFile(relPath: string): number {
  const parts = segments(relPath);
  if (parts.some((part) => NOT_THE_PRODUCT.has(part.toLowerCase()))) return RANK_NONE;
  const ext = extname(relPath);
  if (UI_EXTENSIONS.has(ext)) return RANK_UI;
  const inMessages = parts.slice(0, -1).some((part) => MESSAGE_DIRS.has(part.toLowerCase()));
  if (inMessages && (MESSAGE_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext))) return RANK_MESSAGES;
  return CODE_EXTENSIONS.has(ext) ? RANK_CODE : RANK_NONE;
}

/** Whether this file is worth opening at all. */
function isSearchable(relPath: string): boolean {
  const ext = extname(relPath);
  if (UI_EXTENSIONS.has(ext) || CODE_EXTENSIONS.has(ext)) return true;
  return MESSAGE_EXTENSIONS.has(ext) &&
    segments(relPath).slice(0, -1).some((part) => MESSAGE_DIRS.has(part.toLowerCase()));
}

/**
 * Test-id attributes, and the quoted value each carries. `=` and not `:`,
 * because `testId: "submit"` is an entry in a table of names, not an id
 * declared on an element — and the whole point of matching a test id as an
 * attribute is to find where the element is.
 */
const TESTID_ATTR = /(?:data-test-?id|data-test|data-qa|data-cy|test-?id)\s*=\s*\{?\s*["'`]([^"'`]*)["'`]/gi;

/**
 * Attributes that name an element to a person or a screen reader. A string
 * that is the whole value of one of these is being *rendered*, which is the
 * question the column asks — anywhere else in the file it may equally be a
 * constant, a log line or an analytics event.
 *
 * `=` and not `:`. `name`, `title` and `label` are the commonest keys in a
 * table of navigation entries, and reading `{ name: "Settings" }` as the
 * strongest evidence sends the citation to the constant that defines a label
 * instead of the markup that renders it — which is the failure this ranking
 * exists to fix. A framework that binds an attribute (`:title="…"`) still
 * matches, because the `=` is there.
 */
const LABELLING_ATTR = /(?:aria-label|label|placeholder|name|title|alt)\s*=\s*\{?\s*["'`]([^"'`]*)["'`]/gi;

/** Characters a match may not be glued to, or it is part of a longer word. */
const WORDISH = /[\p{L}\p{N}_]/u;

/**
 * How well one line answers "is this string rendered here". Higher is better;
 * a line scores the best of its occurrences.
 *
 * The first occurrence in a file is the wrong answer often enough to matter: a
 * label's text also appears in the constant that defines it and in the
 * analytics event that fires with it, and those usually come first. So the
 * line is chosen, not taken.
 */
function rankLine(line: string, needle: SourceNeedle): number {
  if (needle.kind === "testid") {
    return attributeValue(TESTID_ATTR, line, needle.value) ? RANK_ATTRIBUTE_ONLY : 0;
  }
  let best = 0;
  for (let at = line.indexOf(needle.value); at !== -1; at = line.indexOf(needle.value, at + 1)) {
    if (isComment(line, at)) continue;
    const before = line[at - 1];
    const after = line[at + needle.value.length];
    // Glued to a letter on either side, this is a longer word that happens to
    // start or end with the string — reported only when nothing else matched.
    if ((before && WORDISH.test(before)) || (after && WORDISH.test(after))) {
      best = Math.max(best, RANK_PARTIAL);
      continue;
    }
    if (attributeValue(LABELLING_ATTR, line, needle.value)) return RANK_LABELLED;
    // Between a `>` and a `<` is element text: what a screen actually shows.
    best = Math.max(best, before === ">" || after === "<" ? RANK_ELEMENT_TEXT : RANK_PLAIN);
  }
  return best;
}

/** Whether the needle is the whole value of one of `attr`'s matches on this line. */
function attributeValue(attr: RegExp, line: string, needle: string): boolean {
  attr.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = attr.exec(line)) !== null) {
    if (m[1] === needle) return true;
  }
  return false;
}

/**
 * How well one line answers "is this string rendered here", best first: the
 * whole value of a labelling attribute, element text between `>` and `<`, any
 * other delimited occurrence, and the string glued inside a longer word.
 */
const RANK_LABELLED = 4;
const RANK_ELEMENT_TEXT = 3;
const RANK_PLAIN = 2;
const RANK_PARTIAL = 1;
/** A test id counts only as an attribute's value, so it has one rank. */
const RANK_ATTRIBUTE_ONLY = 3;

/**
 * The best line of `lines` for this needle, and how good it is — `line: -1`
 * when none of them holds it in a form that counts.
 *
 * The one place a string is located in a file. The audit's citation check asks
 * the same question about the same product source, and answering it twice is
 * how one ccqa output ends up citing a comment while another reports the same
 * string as not found.
 */
export function bestLineFor(
  lines: readonly string[],
  needle: SourceNeedle,
): { line: number; rank: number } {
  const top = needle.kind === "testid" ? RANK_ATTRIBUTE_ONLY : RANK_LABELLED;
  let line = -1;
  let rank = 0;
  for (let i = 0; i < lines.length; i++) {
    // A substring test is a necessary condition for both kinds and far
    // cheaper than the regexes `rankLine` runs, so most lines end here.
    if (!lines[i]!.includes(needle.value)) continue;
    const score = rankLine(lines[i]!, needle);
    if (score > rank) {
      rank = score;
      line = i;
      // Nothing later can beat the best there is, and a needle in a long
      // translation catalogue would otherwise scan the file to its end.
      if (rank === top) break;
    }
  }
  return { line, rank };
}

/**
 * Whether the position is inside a comment. Line-level and deliberately plain:
 * a string only a comment mentions is not something the product renders, and
 * the shapes below cover how every language in the extension lists opens one.
 */
function isComment(line: string, at: number): boolean {
  const trimmed = line.trimStart();
  if (/^(\/\/|\/\*|\*|#|<!--)/.test(trimmed)) return true;
  const slashes = line.lastIndexOf("//", at);
  // `https://` is a URL, not the start of a comment.
  if (slashes > 0 && line[slashes - 1] !== ":") return true;
  return closesAfter(line, "/*", "*/", at) || closesAfter(line, "<!--", "-->", at);
}

/** Whether `at` sits between an `open` and its `close` on the same line. */
function closesAfter(line: string, open: string, close: string, at: number): boolean {
  const start = line.lastIndexOf(open, at);
  return start !== -1 && line.indexOf(close, start + open.length) > at;
}

/**
 * Source files under `rootAbs`, breadth-first. Level-order (not depth-first)
 * matters here: a shallow, likely-relevant file should be read before this
 * scan burns its file budget descending into one deep subtree.
 */
async function* walkSourceFiles(rootAbs: string): AsyncGenerator<string> {
  let level: string[] = [rootAbs];
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          next.push(join(dir, entry.name));
        } else if (entry.isFile()) {
          const abs = join(dir, entry.name);
          if (isSearchable(relative(rootAbs, abs))) yield abs;
        }
      }
    }
    level = next;
  }
}

/** A configured root joined to a path found under it, `/`-separated regardless of the root's own trailing slash. */
function anchorAt(configured: string, relPath: string, line: number): string {
  const prefix = configured.endsWith("/") ? configured : `${configured}/`;
  return `${prefix}${relPath}:${line}`;
}

/**
 * The two the table shows. A third would change nothing a reader acts on —
 * the cell says "ambiguous" either way — and it is what lets the scan stop.
 */
const SHOWN = 2;

/** What has been found for one needle so far: the best rank, and where. */
interface Candidates {
  rank: number;
  /** Which configured root it came from — earlier roots are the better answer. */
  rootIndex: number;
  /** The first two at that rank, in walk order — what the table shows. */
  best: string[];
  /** Every place found is the string glued inside a longer one. */
  partial: boolean;
}

/**
 * Whether more scanning could still change this needle's answer.
 *
 * It cannot once the needle has the best rank there is, in as many places as
 * the table will show: another hit would neither outrank those nor add a line.
 * This is what keeps the scan a lookup — without it, ranking would read every
 * file in the budget even when the first one answered everything.
 */
function settled(c: Candidates | undefined): boolean {
  return c !== undefined && c.rank === RANK_UI && c.best.length >= SHOWN;
}

/**
 * Where each needle appears in the product's source, ranked.
 *
 * Bounded on purpose — this runs on every `ccqa evidence` call, on a
 * reviewer's machine, so it has to behave like a lookup rather than a
 * full-repo grep. Hitting `maxFiles` is not an error, but it is not a result
 * either: whatever was still unresolved lands in `unsearched`, so the table
 * can say "we stopped looking" rather than "the product does not have this".
 *
 * Roots are searched in configured order, and order is priority: a later root
 * only replaces an answer by being a better kind of one. Two places in the
 * same root are what makes an answer ambiguous, not two checkouts holding the
 * same string.
 */
export async function findSourceAnchors(
  needles: readonly SourceNeedle[],
  roots: readonly SourceRoot[],
  opts?: { maxFiles?: number; maxFileBytes?: number },
): Promise<SourceAnchors> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  // Shorter/blank needles match nearly every line — noise, not evidence. They
  // are reported as unsearched rather than dropped: a reviewer must not read
  // "not found" about a string nothing ever looked for.
  const pending: SourceNeedle[] = [];
  const unsearched = new Set<string>();
  for (const needle of needles) {
    if (needle.value.trim().length >= 3) pending.push(needle);
    else unsearched.add(needle.value);
  }
  const candidates = new Map<string, Candidates>();

  let filesRead = 0;
  let budgetSpent = false;
  let settledAll = false;
  for (const [rootIndex, root] of roots.entries()) {
    if (budgetSpent || settledAll) break;
    for await (const fileAbs of walkSourceFiles(root.abs)) {
      if (filesRead >= maxFiles) {
        budgetSpent = true;
        break;
      }
      const relPath = relative(root.abs, fileAbs);
      const rank = rankFile(relPath);
      // A file that could not change any answer is not worth reading: it
      // ranks below what every needle already has, or every needle is done.
      if (rank === RANK_NONE) continue;
      const open = pending.filter((n) => !settled(candidates.get(n.value)));
      if (open.length === 0) {
        settledAll = true;
        break;
      }
      if (open.every((n) => (candidates.get(n.value)?.rank ?? 0) > rank)) continue;
      filesRead++;
      const info = await stat(fileAbs).catch(() => null);
      if (!info || info.size > maxFileBytes) continue;
      const content = await readFile(fileAbs, "utf8").catch(() => null);
      if (content === null) continue;
      collect(content, relPath, root.configured, rank, rootIndex, open, candidates);
    }
  }

  const found = new Map<string, SourceAnchor>();
  for (const needle of pending) {
    const c = candidates.get(needle.value);
    if (!c) {
      if (budgetSpent) unsearched.add(needle.value);
      continue;
    }
    found.set(needle.value, {
      needle: needle.value,
      places: c.best,
      ...(c.partial ? { partial: true } : {}),
    });
  }
  return { found, unsearched };
}

/** Fold one file's hits into the running candidates, one entry per file. */
function collect(
  content: string,
  relPath: string,
  configured: string,
  rank: number,
  rootIndex: number,
  pending: readonly SourceNeedle[],
  candidates: Map<string, Candidates>,
): void {
  const lines = content.split("\n");
  for (const needle of pending) {
    const current = candidates.get(needle.value);
    if (current && current.rank > rank) continue;
    // An earlier root already answered this as well as this file can. Root
    // order is priority, so the later one adds nothing — not even doubt.
    if (current && current.rootIndex < rootIndex && current.rank === rank) continue;
    // The best line in this file, not the first: one entry per file either
    // way, but which line it names is what a reviewer opens.
    const { line: bestLine, rank: bestScore } = bestLineFor(lines, needle);
    if (bestLine === -1) continue;
    const at = anchorAt(configured, relPath, bestLine + 1);
    const partial = bestScore <= RANK_PARTIAL;
    if (!current || current.rank < rank) {
      candidates.set(needle.value, { rank, rootIndex, best: [at], partial });
    } else if (current.best.length < SHOWN) {
      current.best.push(at);
      current.partial = current.partial && partial;
    }
  }
}
