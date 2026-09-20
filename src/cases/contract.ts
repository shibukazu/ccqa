/**
 * What a test case is, and how ccqa is handed one.
 *
 * ccqa reads its own `spec.yaml` and nothing else. Every other way of writing
 * a test case — a team's markdown, a spreadsheet export, rows in a tracker —
 * is read by a module that project owns and points `targets.<id>.cases` at.
 * This file is the whole contract between the two, and the only part of ccqa a
 * reader module sees.
 *
 * Published as the `ccqa/case-source` subpath, and **types only**: a reader
 * imports nothing at runtime, so `// @ts-check` plus a JSDoc
 * `@type {import("ccqa/case-source").CaseSourceFactory}` is the whole
 * integration, and ccqa's own dependencies never reach the consumer's build.
 * (The gate that refuses `ccqa/*` imports inside an emitted test does not
 * apply here — a reader module is not a test.)
 *
 * What ccqa decides, not the reader: step numbering, where the case's working
 * files live, and where its recording goes. A reader that assigned them would
 * be answering for a directory it cannot see.
 */

/** One step of a case, as the document that states it wrote it. */
export interface CaseStep {
  /** What to do. */
  instruction: string;
  /**
   * What this step must make true. Omit it when the case states its
   * expectations once for the whole flow rather than per step — placing them
   * is then the recorder's reading, not the reader's.
   */
  expected?: string;
}

/**
 * One test case, as a source answers for it.
 *
 * Read strictly: an unknown key is refused rather than ignored, so a typo in a
 * reader is reported where it was made instead of quietly costing a field.
 */
export interface Case {
  /**
   * Path-shaped, `/`-separated, no extension — `todo/add_item`. No leading
   * `/`, no `..`, no backslashes. Unique within the source and stable for the
   * life of the case: ccqa files the case's recording and evidence under it,
   * and it is what `{case}` expands to in the target's `testPath`.
   */
  id: string;
  /** Absolute path of the file that states the case. */
  path: string;
  /** That file verbatim. The audit and the failure classifier read it as written. */
  text: string;
  title: string;
  /**
   * `live` drives the case through the browser agent on every run;
   * `deterministic` records it once and compiles a test.
   *
   * Two values, no spellings. A source that reads "manual" or "wip" out of its
   * own documents decides for itself what that means — reading an unrecognised
   * word as "record and generate" is how a case gets automated that nobody
   * meant to automate.
   */
  mode: "deterministic" | "live";
  /** What to do, in order. A case with no steps describes nothing to record. */
  steps: CaseStep[];
  /** What to undo afterwards, whatever the outcome. Emitted into `afterEach`. */
  cleanup?: CaseStep[];
  /**
   * What the case says must be true, unattached to any step. Which step
   * delivers which is a reading of the flow, so ccqa's recorder makes it.
   */
  expectations?: string[];
  /**
   * What the cleanup itself must make true. Kept apart from `expectations`,
   * which are about the flow: these are decided where the undo runs, and
   * asserting them among the case's own steps would check them too early.
   */
  cleanupExpectations?: string[];
  /**
   * Sections ccqa does not interpret, handed to the recorder as context. A
   * precondition belongs here: it says which account to sign in as and what
   * must already exist, which is what whoever runs the case needs to read.
   */
  context?: Array<{ heading: string; body: string }>;
  /**
   * Values the target's `header` template and `titleTags.field` refer to, by
   * whatever names this source gives them. ccqa passes them through and never
   * reads one itself.
   */
  fields?: Record<string, string>;
  /** In the source, but opted out of runs and audits. */
  disabled?: boolean;
}

/** Where a project's test cases come from. */
export interface CaseSource {
  /**
   * Every case id this source holds. This is what a sweep audits and what
   * `ccqa run` expands "all cases" to, so return only what you can load: a
   * README sitting beside the cases is not one. ccqa sorts and de-duplicates.
   */
  list(): Promise<string[]> | string[];
  /**
   * One case, by its id or by the path a CLI argument named — both spellings
   * reach the same case, and the returned `id` is the authoritative one.
   *
   * Throw when the case cannot be read; ccqa reports what you threw and never
   * reads a failure as an empty answer.
   */
  load(ref: string): Promise<Case> | Case;
}

/**
 * The module's default export: a function of the project root.
 *
 * `cwd` is the root ccqa resolved (`--cwd`, else the working directory), so a
 * reader resolves its own paths against it rather than against `process.cwd()`.
 */
export type CaseSourceFactory = (ctx: {
  cwd: string;
}) => CaseSource | Promise<CaseSource>;
