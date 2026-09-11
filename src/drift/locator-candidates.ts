import { resolve } from "node:path";
import type { SourceRoot } from "../config/source-roots.ts";
import { findSourceAnchors } from "../evidence/source-anchors.ts";

/**
 * A locator the test addresses an element by, whose value is not prose — the
 * kinds an audit reads past, so code finds them and the audit confirms them.
 */
export interface LocatorCandidate {
  /** What the reply cites this candidate by. Stable within one audit. */
  id: string;
  kind: "class" | "id" | "testid";
  /** The bare token — `nav-bar`, not `.nav-bar`. */
  value: string;
  /** The whole selector as the test writes it, for context. */
  selector: string;
  /** Where the test writes it, `file:line`. */
  from: string;
}

/** A locator whose value code cannot read — a variable, or an interpolation. */
export interface UnresolvedLocator {
  from: string;
  expression: string;
}

export interface LocatorInventory {
  /** Candidates whose token the product source does render, with where. */
  found: Array<LocatorCandidate & { at: string }>;
  /** Candidates the search did not find. A shortlist, not a verdict. */
  missing: LocatorCandidate[];
  unresolved: UnresolvedLocator[];
  /**
   * Why `missing` is weaker than "the product does not have this": a file the
   * scan could not read, or a budget it ran out of. Empty when the scan was
   * complete, and the prompt says so either way.
   */
  incomplete: string[];
}


/**
 * Locator calls whose argument is a plain string. The quote style is captured
 * so a matching close quote is required — an argument that is anything else
 * (an identifier, a call, a template holding `${`) falls to `UNREADABLE` and
 * is reported unresolved rather than guessed at.
 */
const LOCATOR_CALL = /\.\s*(?:locator|getByTestId)\s*\(\s*(["'`])((?:(?!\1)[^\\])*?)\1/g;
const UNREADABLE = /\.\s*(?:locator|getByTestId)\s*\(\s*(?![\s)"'`])([^),]{1,80})/g;
const TEMPLATE_CALL = /\.\s*(?:locator|getByTestId)\s*\(\s*`([^`]*\$\{[^`]*)`/g;

const CLASS_TOKEN = /\.(-?[A-Za-z_][-\w]*)/g;
const ID_TOKEN = /#(-?[A-Za-z_][-\w]*)/g;
const TESTID_IN_SELECTOR = /\[\s*data-test-?id\s*[~^$*|]?=\s*["']?([^"'\]]+)/gi;

/**
 * A selector's own class and id syntax lives outside its attribute filters:
 * inside `[href="/app.html"]` a `.` is part of a path and a `#` part of a
 * fragment, and taking those for names invents candidates the audit is then
 * required to answer for.
 */
function outsideAttributes(selector: string): string {
  return selector.replace(/\[[^\]]*\]/g, " ");
}

/** Shorter than this, a name matches too much to be evidence either way. */
const SHORTEST_TOKEN = 3;

/** See `buildLocatorInventory`. */
const AUDIT_MAX_FILES = 20_000;

/** A class name's other home. */
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl"]);

/**
 * Pull the class, id and test-id tokens out of one file's locator calls. Text,
 * not a parser: a locator written in a form this does not know costs a
 * candidate, and a token invented would cost a false one, which is worse.
 */
export function locatorsIn(source: string, file: string): {
  candidates: Array<Omit<LocatorCandidate, "id">>;
  unresolved: UnresolvedLocator[];
} {
  const candidates: Array<Omit<LocatorCandidate, "id">> = [];
  const unresolved: UnresolvedLocator[] = [];
  const lines = source.split("\n");
  for (const [i, line] of lines.entries()) {
    const at = `${file}:${i + 1}`;
    for (const call of line.matchAll(LOCATOR_CALL)) {
      const selector = call[2] ?? "";
      const testId = call[0].includes("getByTestId");
      if (testId) {
        if (selector !== "") candidates.push({ kind: "testid", value: selector, selector, from: at });
        continue;
      }
      const bare = outsideAttributes(selector);
      for (const [regex, source, kind] of [
        [CLASS_TOKEN, bare, "class"],
        [ID_TOKEN, bare, "id"],
        [TESTID_IN_SELECTOR, selector, "testid"],
      ] as const) {
        for (const token of source.matchAll(regex)) {
          const value = token[1]!;
          if (value.length >= SHORTEST_TOKEN) candidates.push({ kind, value, selector, from: at });
        }
      }
    }
    for (const regex of [TEMPLATE_CALL, UNREADABLE]) {
      for (const call of line.matchAll(regex)) {
        unresolved.push({ from: at, expression: (call[1] ?? "").trim() });
      }
    }
  }
  return { candidates, unresolved };
}

export interface BuildInventoryInput {
  /** The test and the support files it imports, as project-relative `path` → source. */
  sources: ReadonlyMap<string, string>;
  roots: readonly SourceRoot[];
  /** What `sources`' paths are relative to. */
  cwd: string;
}

/**
 * Which of the test's non-prose locators the product source renders, and which
 * it does not.
 *
 * A token found is not a locator cleared: it may belong to another component,
 * an obsolete definition, or a branch this case never reaches. So this
 * shortlists and the audit judges — the one thing it must never do is let a
 * missing token be reported as a verdict on its own.
 */
export async function buildLocatorInventory(input: BuildInventoryInput): Promise<LocatorInventory> {
  const candidates: LocatorCandidate[] = [];
  const unresolved: UnresolvedLocator[] = [];
  const seen = new Set<string>();
  for (const [path, source] of input.sources) {
    const parsed = locatorsIn(source, path);
    unresolved.push(...parsed.unresolved);
    for (const candidate of parsed.candidates) {
      const key = `${candidate.kind}:${candidate.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...candidate, id: `L${candidates.length + 1}` });
    }
  }
  if (candidates.length === 0) return { found: [], missing: [], unresolved, incomplete: [] };

  const anchors = await findSourceAnchors(
    candidates.map((c) => ({ value: c.value, kind: "token" as const })),
    input.roots,
    {
      // A class name's other home is the stylesheet that declares it, and
      // "not found" is only worth saying when both were read.
      extraExtensions: STYLE_EXTENSIONS,
      skip: new Set([...input.sources.keys()].map((p) => resolve(input.cwd, p))),
      // Far above the evidence table's, which runs on a reviewer's machine and
      // has to behave like a lookup. A budget spent before a token is looked
      // for turns a miss into "not searched", and a miss nobody asks about is
      // the whole failure this scan exists to close. The walk stops as soon as
      // every token is located, so the full cost is paid only when something
      // really is absent — which is the case worth paying for.
      maxFiles: AUDIT_MAX_FILES,
    },
  );

  const found: LocatorInventory["found"] = [];
  const missing: LocatorCandidate[] = [];
  const incomplete: string[] = [];
  for (const candidate of candidates) {
    const at = anchors.found.get(candidate.value)?.places[0];
    if (at !== undefined) found.push({ ...candidate, at });
    else if (anchors.unsearched.has(candidate.value)) {
      incomplete.push(`${candidate.kind} ${candidate.value}: the scan stopped before it was looked for`);
    } else missing.push(candidate);
  }
  return { found, missing, unresolved, incomplete };
}

export function checkLocatorVerdicts(
  missing: readonly LocatorCandidate[],
  reply: { drift: unknown; locators: ReadonlyArray<{ id: string; verdict: string }> },
): string | null {
  if (missing.length === 0) return null;
  const answered = new Map(reply.locators.map((l) => [l.id, l.verdict]));
  const silent = missing.filter((c) => !answered.has(c.id));
  if (silent.length > 0) {
    return `no verdict for ${silent.map((c) => `${c.id} (${c.kind} ${c.value})`).join(", ")} — ` +
      `every locator in the list needs one, "fine" with a reason included`;
  }
  const drifted = missing.filter((c) => answered.get(c.id) === "drifted");
  if (drifted.length > 0 && reply.drift === null) {
    return `${drifted.map((c) => c.id).join(", ")} answered "drifted" while the case answered "no drift" — ` +
      `a locator the product does not render is a finding, so say which it is`;
  }
  return null;
}
