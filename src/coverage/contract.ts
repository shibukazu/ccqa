/**
 * The names and shapes ccqa agrees on with the instrumented application.
 *
 * Restated from `ccqa-tools`'s `wire.ts` rather than imported: the CLI must
 * not depend on the instrumentation SDK, which is installed in the application
 * under test and versioned separately. `contract.test.ts` asserts the two still
 * agree — a drift here reports "the spec reached no server code", which is
 * indistinguishable from the truth it is supposed to measure.
 *
 * Not named `wire.ts` like its counterpart, deliberately. The one moment anyone
 * opens both is while working out why the sink saw nothing, and two tabs with
 * one name is the wrong thing to hand them.
 */

/** Set on the browser by the acquisition engine, scoped to the instrumented origins. */
export const COVERAGE_COOKIE = "__ccqa_coverage";

/** What the browser engine leaves for the run to read back at collect time. */
export const FRONTEND_COVERAGE_FILE = "coverage-frontend.json";

export interface FrontendCoverage {
  specId: string;
  files: string[];
  /** Scripts that ran but whose source could not be traced back to a file. */
  unmappedScripts: number;
  /** Executed ranges that mapped to no original source. */
  unmappedRanges: number;
  /** Sources whose name could not be turned into a project path. */
  unresolvedSources: number;
  /** Sources dropped because they are dependency code. Excluded on purpose, so not a gap. */
  excludedDependencies: number;
  /** Collection died mid-spec; what ran after that point was never seen. */
  stopped: boolean;
}

/** The only spec-id shape this run issues, and the only one the sink accepts. */
export const SPEC_ID_PATTERN = /^[A-Za-z0-9._\-/]{1,200}$/;
