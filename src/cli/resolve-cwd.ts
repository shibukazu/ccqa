import { resolve } from "node:path";

/**
 * Resolve the `--cwd <path>` option that drift / run / record share.
 *
 * The cwd argument controls two things at once:
 *   - where ccqa looks for the `.ccqa/` directory
 *   - the base directory Claude reads source files from (Read / Grep / Glob)
 *
 * It's mostly useful in monorepos where you want to invoke ccqa from the
 * repo root but target a subpackage (e.g.
 * `ccqa run --cwd apps/web-app`).
 *
 * Falls back to `process.cwd()` when the option is not given.
 */
export function resolveCwd(cwdOpt: string | undefined): string {
  return cwdOpt ? resolve(cwdOpt) : process.cwd();
}
