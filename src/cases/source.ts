import type { CaseDocument, TestCase } from "./case.ts";

/**
 * What a source answers for one case.
 *
 * Three outcomes, not two: read, absent, and there-but-unreadable. Everything
 * read off a case falls back to a default when the read fails, so a broken
 * document must not look like a case that declares nothing. And a document
 * that will not parse is still a document — the audit reads what its author
 * wrote either way — so it is carried here even when no case came of it.
 */
export interface CaseRead {
  /** The canonical id of the case that was asked for, whatever spelling named it. */
  id: string;
  /** The case. Null when its document is missing or will not parse. */
  case: TestCase | null;
  /** The file, when there is one. Null means there is no such case. */
  document: CaseDocument | null;
  /** Why no case was made. Null when one was. */
  error: string | null;
}

/**
 * How the door drives one kind of source. Not the published contract — that
 * is `./contract.ts`, which a project's own module answers; this is the
 * narrower thing ccqa reads both kinds through.
 */
export interface CaseAdapter {
  /** Every case id this source holds. Includes disabled cases. */
  list(): Promise<string[]>;
  /**
   * The id an argument names. Both spellings reach the same case: the file as
   * a person sees it in their editor, and the id everything else cites.
   */
  idFor(ref: string): string;
  /** Never throws: an unreadable case is an outcome, not a failure. */
  read(id: string): Promise<CaseRead>;
}
