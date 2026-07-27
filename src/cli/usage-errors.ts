import { RunUsageError } from "../run/errors.ts";
import * as log from "./logger.ts";

/**
 * Turn a `RunUsageError` into `[error] <message>` plus its exit code, for a
 * commander action.
 *
 * The helpers shared across commands — `resolveAnalysisBase`,
 * `collectChangedSpecs` — signal a bad invocation this way, so every command
 * that calls one needs the same boundary. Without it the process dies on an
 * unhandled rejection and prints a stack trace: `bin/ccqa.ts` installs no
 * global handler, so there is nowhere else for it to land.
 *
 * Lives here rather than beside `RunUsageError` because `src/run/errors.ts` is
 * deliberately dependency-free, and this needs the logger.
 */
export function withUsageErrors<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof RunUsageError) {
        log.error(err.message);
        process.exit(err.exitCode);
      }
      throw err;
    }
  };
}
