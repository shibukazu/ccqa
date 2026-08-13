/**
 * The names and shapes ccqa agrees on with the two things it talks to: the
 * instrumented application, and the test process it spawns.
 *
 * Restated from `ccqa-coverage`'s `wire.ts` rather than imported: the CLI must
 * not depend on the instrumentation SDK, which is installed in the application
 * under test and versioned separately. `contract.test.ts` asserts the two still
 * agree — a drift here reports "the spec reached no server code", which is
 * indistinguishable from the truth it is supposed to measure.
 *
 * Not named `wire.ts` like its counterpart, deliberately. The one moment anyone
 * opens both is while working out why the sink saw nothing, and two tabs with
 * one name is the wrong thing to hand them.
 *
 * Nothing here imports anything: `ccqa/coverage-hooks` is a public subpath
 * that runs inside a consumer's test process and pulls this file in.
 */

/** Set on the browser by ccqa at spec start, scoped to the target origins. */
export const COVERAGE_COOKIE = "__ccqa_coverage";

/** Set on the spec's test process by `ccqa run --coverage`. */
export const COVERAGE_SPEC_ENV = "CCQA_COVERAGE_SPEC";
export const COVERAGE_ORIGINS_ENV = "CCQA_COVERAGE_ORIGINS";
export const COVERAGE_ARTIFACTS_ENV = "CCQA_COVERAGE_ARTIFACTS";

/**
 * Absolute directory reported paths are relative to. Defaults to the test
 * process's own directory, which is right until the project under test is one
 * package of a workspace and its siblings live above it.
 *
 * Deliberately the name `ccqa-coverage` already reads for the same thing: the
 * two halves have to root their paths identically or the same file arrives
 * under two names and the union double-counts it.
 */
export const COVERAGE_ROOT_ENV = "CCQA_COVERAGE_ROOT";

/** What `ccqa/coverage-hooks` leaves for the run to read back. */
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
