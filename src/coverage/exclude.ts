import { compileGlob, stripLeadingDotSlash } from "../drift/affected.ts";

/** `coverage.exclude` as a predicate over `projectRoot`-relative paths. */
export type CoverageExcluder = (path: string) => boolean;

export function makeCoverageExcluder(patterns: readonly string[] = []): CoverageExcluder {
  const globs = patterns.map(compileGlob);
  return (path) => globs.some((glob) => glob.test(stripLeadingDotSlash(path)));
}
