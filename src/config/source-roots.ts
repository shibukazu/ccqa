import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

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
    const abs = resolve(cwd, configured);
    const info = await stat(abs).catch(() => null);
    if (!info?.isDirectory()) {
      const where = isAbsolute(configured) ? "" : ` (resolved from ${cwd})`;
      throw new Error(
        `sourceRoots entry "${configured}" is not a directory${where}: the audit reads the product's source from there`,
      );
    }
    resolved.push({ configured, abs: await realpath(abs) });
  }
  return resolved;
}
