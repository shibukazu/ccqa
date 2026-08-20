import { relative, resolve, sep } from "node:path";

import type { CoverageConfig } from "../runtime-env.ts";

export const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

/**
 * Decides whether a file is part of the project under test, returning its id
 * if so. Returning the id here — rather than a plain boolean — spares the
 * caller a second `fileIdFor` pass over the same path.
 *
 * `node_modules` is excluded unconditionally: instrumenting dependencies costs
 * the most and answers the least — nobody adds a test because a library file
 * went unreached.
 */
export function shouldInstrument(
  filename: string,
  config: Pick<CoverageConfig, "root" | "include">,
): string | undefined {
  if (filename.includes(`${sep}node_modules${sep}`)) return undefined;
  if (!SOURCE_EXTENSIONS.some((extension) => filename.endsWith(extension))) return undefined;
  const id = fileIdFor(filename, config.root);
  if (id === undefined) return undefined;
  return config.include.some((prefix) => id === prefix || id.startsWith(`${prefix}/`)) ? id : undefined;
}

/** Path relative to the project root, in posix form so ids match across hosts. */
export function fileIdFor(filename: string, root: string): string | undefined {
  const rel = relative(resolve(root), filename);
  if (rel.startsWith("..") || rel === "") return undefined;
  return rel.split(sep).join("/");
}
