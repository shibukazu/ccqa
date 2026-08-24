/**
 * Strips a source map down to what coverage reads.
 *
 * `prepareSourceMap` uses `version`, `sources`, `sourceRoot` and `mappings`
 * and nothing else — in particular never `sourcesContent`, which carries the
 * original source in full and is typically the larger half of the file. A
 * build that keeps its maps off the CDN does so precisely to not hand that
 * out, so storing it anyway would recreate what the build refused, for data
 * no reader consults.
 */

/** The fields of a source map that coverage reads. */
export interface ReducedSourceMap {
  version: 3;
  sources: (string | null)[];
  mappings: string;
  sourceRoot?: string;
  /** Kept because it names the output this map belongs to, which aids diagnosis. */
  file?: string;
}

/**
 * `json` reduced to the readable fields, or undefined when it is not a source
 * map this side can use — the same refusals `parseSourceMap` makes, applied at
 * push time so an unusable map is never stored.
 */
export function reduceSourceMap(json: string): ReducedSourceMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const map = parsed as Record<string, unknown>;
  // Section maps need a different decoder; refused whole rather than in part.
  if (map.sections !== undefined) return undefined;
  if (map.version !== 3) return undefined;
  if (typeof map.mappings !== "string") return undefined;
  if (!Array.isArray(map.sources)) return undefined;

  return {
    version: 3,
    sources: map.sources as (string | null)[],
    mappings: map.mappings,
    ...(typeof map.sourceRoot === "string" ? { sourceRoot: map.sourceRoot } : {}),
    ...(typeof map.file === "string" ? { file: map.file } : {}),
  };
}
