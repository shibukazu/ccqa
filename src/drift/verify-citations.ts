import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FailureEvidence } from "../report/schema.ts";
import { bestLineFor } from "../evidence/source-anchors.ts";

/**
 * Check the audit's own citations against the files they name.
 *
 * A model's line numbers are not reliably right, and they are not reliably
 * wrong either — measured over one phase, every `TEST_DRIFT` citation pointed
 * at a `}` or a blank line while every `SPEC_CHANGE` one was exact. A reader
 * cannot tell which kind they are holding, so a citation that does not survive
 * being looked at is worth less than no line number at all.
 *
 * The check is the one a reader would do: open the file, look at the line, see
 * whether the string the finding quotes is on it. Nothing here judges the
 * finding — only whether its citation points where it says.
 */

/**
 * Quoted runs in a finding's prose — what the citation is supposed to show.
 *
 * Each delimiter closes with its own kind, and an apostrophe inside a word is
 * not a delimiter at all. Letting any quote close any other turns "it doesn't
 * render the \"Submit\" label" into a run starting at the apostrophe, which
 * loses the real string and invents one — and an invented string that happens
 * to occur somewhere *moves* the citation there and stamps it corrected, which
 * is the failure this module exists to prevent.
 */
const QUOTED =
  /`([^`\n]{3,})`|"([^"\n]{3,})"|(?<![\p{L}\p{N}])'([^'\n]{3,})'(?![\p{L}\p{N}])|[“”]([^“”\n]{3,})[“”]|(?<![\p{L}\p{N}])[‘’]([^‘’\n]{3,})[‘’](?![\p{L}\p{N}])/gu;

export function quotedStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const value = m.slice(1).find((g) => g !== undefined);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** `path:line` split into its halves, or null when there is no line to check. */
/** The path half of a `path:line` citation, or the whole of one with no line. */
export function citedPath(file: string): string {
  return splitCitation(file)?.path ?? file;
}

function splitCitation(file: string): { path: string; line: number } | null {
  const m = /^(.*):(\d+)$/.exec(file);
  const line = m ? Number.parseInt(m[2]!, 10) : NaN;
  return m && line > 0 ? { path: m[1]!, line } : null;
}

/**
 * One citation, checked and — where the file holds the string somewhere else —
 * corrected to the line that does.
 *
 * Correcting rather than rejecting: the model found the right file and quoted
 * something real, and sending a reader to the wrong line in the right file is
 * a fixable mistake. When the string is nowhere in the file, nothing is
 * changed and the citation is marked, because guessing which of the two halves
 * is wrong is not something reading the file can settle.
 */
export async function verifyCitation(
  evidence: FailureEvidence,
  quoted: readonly string[],
  roots: readonly string[],
): Promise<FailureEvidence> {
  const cited = evidence.file === undefined ? null : splitCitation(evidence.file);
  if (cited === null || quoted.length === 0) return evidence;

  const contents = await firstReadable(cited.path, roots);
  // Unreadable is not unverified: the audit may have cited a path relative to
  // a root this process cannot resolve, and saying "wrong" about that would be
  // a claim about the finding rather than about the file.
  if (contents === null) return evidence;

  const lines = contents.split(/\r?\n/);
  // A citation that holds what it quotes is left exactly as it was: there is
  // nothing for a reader to do about it, and saying so is a fourth state.
  const at = lines[cited.line - 1];
  if (at !== undefined && quoted.some((q) => at.includes(q))) return evidence;

  // Located the same way the evidence table locates a string, so a citation is
  // never *moved onto* a comment or a constant — which is the mistake this
  // correction exists to undo, and would be worse for carrying a mark that
  // says a person checked it.
  const found = quoted
    .map((q) => bestLineFor(lines, { value: q, kind: "text" }))
    .filter((r) => r.line !== -1)
    .sort((a, b) => b.rank - a.rank)[0];
  if (found === undefined) return { ...evidence, citation: "unverified" };
  return { ...evidence, file: `${cited.path}:${found.line + 1}`, citation: "corrected" };
}

/** Every citation of one finding, checked against the roots it may have come from. */
export async function verifyCitations(
  evidence: readonly FailureEvidence[],
  context: { headline: string; roots: readonly string[] },
): Promise<FailureEvidence[]> {
  const fromHeadline = quotedStrings(context.headline);
  return Promise.all(
    evidence.map((e) =>
      verifyCitation(e, [...quotedStrings(e.detail), ...fromHeadline], context.roots),
    ),
  );
}

/**
 * The cited path read from whichever root holds it, or null. Caller order is
 * priority, and the product's own roots come first: a citation naming the
 * application would otherwise be checked against a same-named file in the
 * repository the tests live in, which is the setup this exists for.
 */
async function firstReadable(path: string, roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    const text = await readFile(resolve(root, path), "utf8").catch(() => null);
    if (text !== null) return text;
  }
  return null;
}
