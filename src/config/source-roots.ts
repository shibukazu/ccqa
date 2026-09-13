import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { resolveEnvRefs } from "../runtime/env-vars.ts";
import { RunUsageError } from "../run/errors.ts";

/**
 * A directory holding the product's own source, resolved.
 *
 * The audit reads these as the right answer a case is checked against, so what
 * matters here is that the path the model is handed is the one the filesystem
 * actually walks: search tools do not follow symlinks, and a root reached
 * through one would look empty rather than wrong.
 */
export interface SourceRoot {
  /** As the project wrote it, for messages and prompts. */
  configured: string;
  /** The real absolute directory, symlinks resolved. */
  abs: string;
}

/**
 * Resolve the configured roots, refusing any that is not a directory.
 *
 * A missing root is an error rather than a skip: an audit that quietly reads
 * nothing reports no drift, which is indistinguishable from a clean sweep.
 */
export async function resolveSourceRoots(
  cwd: string,
  roots: readonly string[],
): Promise<SourceRoot[]> {
  const resolved: SourceRoot[] = [];
  for (const configured of roots) {
    resolved.push({
      configured,
      abs: await resolveConfiguredDir(cwd, configured, `sourceRoots entry "${configured}"`),
    });
  }
  return resolved;
}

/**
 * A directory a project configured, resolved the way every one of them must
 * be: `${VAR}` refs expanded, relative to the working directory, and through
 * to a real path — a checkout reached by a symlink otherwise compares unequal
 * to the same checkout reached directly, and everything under it is dropped.
 *
 * It may sit outside the working directory. For a project whose tests are one
 * checkout and whose application is another, that is the ordinary case.
 *
 * Every failure here is otherwise silent and looks exactly like success: a
 * directory that is not there sends every path outside it, and the command
 * reports a smaller set with no error at all. So each one throws, and throws
 * the type the CLI already turns into an exit code.
 */
export async function resolveConfiguredDir(
  cwd: string,
  declared: string,
  what: string,
): Promise<string> {
  // A `${VAR}` nobody set substitutes to "", and `resolve(cwd, "")` is `cwd` —
  // indistinguishable from never having configured one.
  const substituted = resolveEnvRefs(declared).trim();
  if (substituted === "") {
    throw new RunUsageError(`${what} resolved to nothing — is the variable set?`);
  }
  const abs = resolve(cwd, substituted);
  const info = await stat(abs).catch(() => null);
  if (!info?.isDirectory()) {
    const where = isAbsolute(substituted) ? "" : ` (resolved from ${cwd})`;
    throw new RunUsageError(`${what} is not a directory${where}: ${abs}`);
  }
  return realpath(abs).catch(() => abs);
}
