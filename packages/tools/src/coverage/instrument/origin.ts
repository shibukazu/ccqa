import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { fileIdFor } from "./select.ts";

/**
 * Reports a build output under the source it was compiled from.
 *
 * A server that runs from `dist/` would otherwise be measured in terms of its
 * own build artefacts, which nobody can act on: the answer has to name files
 * that exist in the repository. A 1:1 build — one output file per source file,
 * which is what an unbundled compile produces — says exactly which source that
 * is in its map's single `sources` entry.
 *
 * Only that single-source case is handled. A bundle's map lists every file
 * that went into it and cannot say which one the code at hand came from
 * without full mapping resolution, which is the build plugin's job, not the
 * loader's.
 */
export function originalFileId(
  filename: string,
  code: string,
  root: string,
): string | undefined {
  const reference = readSourceMappingUrl(code);
  if (reference === undefined) return undefined;
  const map = loadMap(filename, reference);
  if (map === undefined) return undefined;
  const sources = map.sources;
  if (!Array.isArray(sources) || sources.length !== 1) return undefined;
  const source = sources[0];
  if (typeof source !== "string" || source === "") return undefined;
  return fileIdFor(resolve(dirname(filename), map.sourceRoot ?? "", source), root);
}

interface MinimalMap {
  sources?: unknown;
  sourceRoot?: string;
}

function loadMap(filename: string, reference: string): MinimalMap | undefined {
  const json = reference.startsWith("data:")
    ? decodeDataUrl(reference)
    : readSibling(filename, reference);
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json) as MinimalMap;
  } catch {
    return undefined;
  }
}

function readSibling(filename: string, reference: string): string | undefined {
  if (/^[a-z]+:/i.test(reference)) return undefined;
  try {
    return readFileSync(resolve(dirname(filename), reference), "utf8");
  } catch {
    return undefined;
  }
}

function decodeDataUrl(url: string): string | undefined {
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const payload = url.slice(comma + 1);
  try {
    return url.slice(0, comma).includes(";base64")
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

// Both spellings, because a tool that emits the older `//@` form would
// otherwise have its build output reported under a path that exists nowhere.
// Kept identical to the CLI's own reader (`src/coverage/source-map.ts`) — the
// two cannot import each other, so the grammar has to be deliberately the same.
const SOURCE_MAPPING_URL = /\/\/[#@][ \t]*sourceMappingURL=(\S+)/g;

export function readSourceMappingUrl(code: string): string | undefined {
  let found: string | undefined;
  for (const match of code.matchAll(SOURCE_MAPPING_URL)) found = match[1];
  return found;
}
