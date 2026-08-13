/**
 * Follows a build output back to the source it was compiled from.
 *
 * A workspace package is consumed through its published entry, so a bundler
 * names it `packages/x/dist/index.mjs`. That file exists and is genuinely what
 * ran, but nobody edits it — reported as-is it becomes an entry in the
 * untested-file list that no test could ever cover.
 *
 * Only a 1:1 build is followed: one output per input, which is what an
 * unbundled compile produces and what its map states in a single `sources`
 * entry. A bundle's map lists everything that went into it and cannot say
 * which of them the file "is", so those are left pointing at the output.
 *
 * The server half follows the same 1:1 rule at load time, in `ccqa-coverage`'s
 * `instrument/origin.ts`. It reaches further: it already holds the code, so it
 * can read an inline map, where this side only reads a sibling `.map`. A
 * package built with an inline map is therefore reported under its source by
 * the server and under its build output by the browser.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parseSourceMap } from "./source-map.ts";
import { toProjectRelative } from "./source-path.ts";

/**
 * The project-relative source `path` was built from, or undefined to keep
 * `path` as it is.
 *
 * Only the sibling `<file>.map` convention is read. Finding an inline map means
 * reading the whole build output on the chance it carries one, which is a lot
 * of I/O for a case library builds rarely emit.
 */
export function sourceBehindBuildOutput(path: string, root: string): string | undefined {
  const output = join(root, path);
  let json: string;
  try {
    json = readFileSync(`${output}.map`, "utf8");
  } catch {
    return undefined;
  }
  const map = parseSourceMap(json);
  if (map === undefined || map.sources.length !== 1) return undefined;
  const source = map.sources[0];
  if (typeof source !== "string" || source === "") return undefined;

  const absolute = resolve(dirname(output), map.sourceRoot ?? "", source);
  const rel = toProjectRelative(root, absolute);
  if (rel === undefined) return undefined;
  // A package that ships a map but not the sources it names would otherwise
  // trade a file the reader can open for one that does not exist — and the
  // caller drops paths it cannot find, so the reach would vanish entirely.
  return existsSync(absolute) ? rel : undefined;
}
