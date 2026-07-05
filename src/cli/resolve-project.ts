import { basename } from "node:path";
import { resolveCwd } from "./resolve-cwd.ts";
import * as log from "./logger.ts";

/** Same shape the hub accepts for a path segment (validate.ts) — checked here so a bad name fails fast and actionably. */
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The hub project a secret belongs to. Defaults to the cwd's directory name —
 * the same convention as `hub push` — so pushing results and managing secrets
 * from the same `.ccqa` tree land in the same project without ever typing it.
 * A derived name the hub would reject (empty at a filesystem root, spaces,
 * a leading dot) exits here with a hint instead of as a confusing 400/404.
 */
export function resolveProject(opts: { project?: string; cwd?: string }): string {
  try {
    return resolveProjectOrThrow(opts.project, resolveCwd(opts.cwd));
  } catch (err) {
    if (err instanceof ProjectNameError) {
      log.error(err.message);
      log.hint("pass --project <name> explicitly");
      process.exit(2);
    }
    throw err;
  }
}

/** Thrown by `resolveProjectOrThrow` when the project name can't be resolved/validated. */
export class ProjectNameError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Non-exiting counterpart to `resolveProject`, for library call sites that
 * can't `process.exit` (e.g. `executeRun`). Same validation, but throws
 * `ProjectNameError` instead — the caller decides how to map it (usage error,
 * or swallow into a best-effort `undefined`).
 */
export function resolveProjectOrThrow(project: string | undefined, cwd: string): string {
  const resolved = project ?? basename(cwd);
  if (resolved.length === 0 || resolved.length > 128 || !PROJECT_NAME.test(resolved)) {
    throw new ProjectNameError(
      project
        ? `invalid --project "${project}" (letters, digits, '.', '_', '-'; must not start with '.')`
        : `could not derive a valid project name from the directory "${resolved}"`,
    );
  }
  return resolved;
}
