/**
 * Turns "which byte ranges of a generated file did V8 execute" into "which
 * original source files does that correspond to", using the file's source
 * map. This is the only thing coverage measurement needs from a source map:
 * not line/column fidelity, not original source text, just the set of
 * original file names touched by at least one covered range.
 *
 * That narrower goal is why this module decodes mappings itself instead of
 * depending on a source-map library: it only ever needs a name, never a
 * position to show a human, so a minimal VLQ decoder plus a same-pass offset
 * lookup is enough — and ccqa carries no runtime dependencies beyond
 * commander/yaml/zod/the Claude SDK.
 *
 * The one rule that shapes every decision below: an unresolvable range must
 * never be treated as covering a source. Reach coverage exists to say "this
 * file was never touched" with confidence, so ambiguity has to fail toward
 * "unknown" (surfaced via `unmappedRanges`), never toward "covered".
 */

/** A raw source map, as parsed from JSON. Only the fields we use. */
export interface RawSourceMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources: (string | null)[];
  sourcesContent?: (string | null)[];
  mappings: string;
  /** Index maps (sections) are not supported; see `parseSourceMap`. */
  sections?: unknown;
}

/** One executed byte range in the generated file. */
export interface CoveredRange {
  startOffset: number;
  endOffset: number;
}

export interface SourceResolution {
  /** Original source paths (as they appear in `sources`, joined with sourceRoot) that any covered range maps to. */
  sources: string[];
  /** Covered ranges that produced no mapping at all. Never silently ignored. */
  unmappedRanges: number;
}

/** Parses a source map JSON string. Returns undefined for anything unusable. */
export function parseSourceMap(json: string): RawSourceMap | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Record<string, unknown>;

  // Section (index) maps point at other maps by generated-code offset
  // instead of carrying `mappings` directly; decoding them correctly is a
  // different algorithm. Rather than decode part of the file and guess at
  // the rest, we refuse the whole map.
  if (candidate.sections !== undefined) return undefined;
  if (candidate.version !== 3) return undefined;
  if (typeof candidate.mappings !== "string") return undefined;
  if (!Array.isArray(candidate.sources)) return undefined;

  // Narrowed field-by-field above; the cast covers the rest of `RawSourceMap`'s
  // optional fields, which we don't validate because we don't read them.
  return candidate as unknown as RawSourceMap;
}

const SOURCE_MAPPING_URL_RE = /\/\/[#@][ \t]*sourceMappingURL=([^\s]+)/g;

/** Extracts the `//# sourceMappingURL=` value from generated code, if present. */
export function readSourceMappingUrl(code: string): string | undefined {
  let last: string | undefined;
  for (const match of code.matchAll(SOURCE_MAPPING_URL_RE)) {
    last = match[1];
  }
  return last;
}

const DATA_URL_RE = /^data:([^,]*),(.*)$/s;

/** Decodes a `data:` source map URL into its JSON text. Returns undefined otherwise. */
export function decodeInlineSourceMap(url: string): string | undefined {
  const match = DATA_URL_RE.exec(url);
  if (!match) return undefined;
  const [, meta, payload] = match;
  if (meta === undefined || payload === undefined || !/^application\/json/.test(meta)) return undefined;
  try {
    return /;base64$/.test(meta) ? Buffer.from(payload, "base64").toString("utf-8") : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

function joinSourceRoot(root: string | undefined, source: string): string {
  if (typeof root !== "string" || root === "") return source;
  return root.endsWith("/") ? `${root}${source}` : `${root}/${source}`;
}

const VLQ_CONTINUATION_BIT = 0x20;
const VLQ_VALUE_MASK = 0x1f;
const VLQ_SHIFT = 5;
const BASE64_INDEX = new Map<string, number>(
  Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").map((ch, i) => [ch, i]),
);

/**
 * Decodes one VLQ value starting at `pos`. Uses multiplication rather than
 * bit shifts so values beyond 32 bits (large generated files) decode
 * correctly — `<<` in JS truncates to a signed 32-bit int.
 */
function decodeVlq(mappings: string, pos: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let i = pos;
  for (;;) {
    const char = mappings[i];
    if (char === undefined) throw new Error("truncated VLQ in mappings");
    const digit = BASE64_INDEX.get(char);
    if (digit === undefined) throw new Error(`invalid base64 digit in mappings: ${char}`);
    i += 1;
    result += (digit & VLQ_VALUE_MASK) * 2 ** shift;
    if ((digit & VLQ_CONTINUATION_BIT) === 0) break;
    shift += VLQ_SHIFT;
  }
  const negative = result % 2 === 1;
  const magnitude = Math.floor(result / 2);
  return { value: negative ? -magnitude : magnitude, next: i };
}

interface MappingSegment {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
}

function isSegmentBoundary(mappings: string, pos: number): boolean {
  return pos >= mappings.length || mappings[pos] === "," || mappings[pos] === ";";
}

/**
 * Decodes `mappings` into segments that carry source info (the 4- and
 * 5-field kind). 1-field segments (generated code with no original source)
 * are skipped: they can never contribute a source, so keeping them around
 * would only cost time later.
 */
function decodeMappings(mappings: string): MappingSegment[] {
  const segments: MappingSegment[] = [];
  const len = mappings.length;
  let pos = 0;
  let generatedLine = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  // Decoded to keep the running deltas correct for later segments, even
  // though coverage never reads original line/column.
  let sourceLine = 0;
  let sourceColumn = 0;

  while (pos < len) {
    const char = mappings[pos];
    if (char === ";") {
      generatedLine += 1;
      generatedColumn = 0;
      pos += 1;
      continue;
    }
    if (char === ",") {
      pos += 1;
      continue;
    }

    const col = decodeVlq(mappings, pos);
    generatedColumn += col.value;
    pos = col.next;

    if (isSegmentBoundary(mappings, pos)) continue; // 1-field segment

    const srcIndex = decodeVlq(mappings, pos);
    sourceIndex += srcIndex.value;
    pos = srcIndex.next;

    const srcLine = decodeVlq(mappings, pos);
    sourceLine += srcLine.value;
    pos = srcLine.next;

    const srcColumn = decodeVlq(mappings, pos);
    sourceColumn += srcColumn.value;
    pos = srcColumn.next;

    segments.push({ generatedLine, generatedColumn, sourceIndex });

    if (!isSegmentBoundary(mappings, pos)) {
      const nameIndex = decodeVlq(mappings, pos); // 5th field: unused, decoded only to advance `pos`
      pos = nameIndex.next;
    }
  }

  return segments;
}

interface SourcePosition {
  offset: number;
  sourceIndex: number;
}

/**
 * A map with everything derived from it already computed: the mapping stream
 * decoded once, the source names joined once.
 *
 * Front-end coverage is taken again at every navigation, and re-decoding a
 * bundle's `mappings` each time dominated the cost. Keeping only this — never
 * the raw map — also keeps `mappings` and `sourcesContent`, the two largest
 * fields a build emits, out of the test process for the rest of the run.
 */
export interface PreparedSourceMap {
  positions: SourcePosition[];
  /** Source index -> path, `sourceRoot` already applied. */
  paths: (string | undefined)[];
}

export function prepareSourceMap(
  map: RawSourceMap,
  generatedCode: string,
): PreparedSourceMap | undefined {
  const lineStarts = computeLineStarts(generatedCode);
  const positions: SourcePosition[] = [];
  let segments: MappingSegment[];
  try {
    segments = decodeMappings(map.mappings);
  } catch {
    // Malformed `mappings`: refuse the whole map rather than resolve from a
    // partially-decoded, untrustworthy position list.
    return undefined;
  }
  for (const segment of segments) {
    const lineStart = lineStarts[segment.generatedLine];
    // A mapping past the end of `generatedCode` means the map and the code we
    // were given disagree; skip rather than guess an offset.
    if (lineStart === undefined) continue;
    positions.push({ offset: lineStart + segment.generatedColumn, sourceIndex: segment.sourceIndex });
  }
  positions.sort((a, b) => a.offset - b.offset);
  const paths = map.sources.map((source) =>
    source === null ? undefined : joinSourceRoot(map.sourceRoot, source),
  );
  return { positions, paths };
}

/** Start offset (UTF-16 code units) of each line in `code`, index 0 for line 0. */
function computeLineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Index of the first mapped position at or after `offset`. */
function lowerBound(positions: readonly SourcePosition[], offset: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((positions[mid]?.offset ?? 0) < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Which of `prepared`'s sources the covered ranges touch.
 *
 * Every range is walked even once all sources are known, because a range that
 * maps nowhere has to be counted — dropping it would turn an unknown into a
 * silent "never reached".
 */
export function resolveCovered(
  prepared: PreparedSourceMap,
  ranges: readonly CoveredRange[],
): SourceResolution {
  const seen = new Uint8Array(prepared.paths.length);
  const sources: string[] = [];
  let unmappedRanges = 0;

  for (const range of ranges) {
    let matched = false;
    for (let i = lowerBound(prepared.positions, range.startOffset); i < prepared.positions.length; i++) {
      const position = prepared.positions[i];
      if (position === undefined || position.offset >= range.endOffset) break;
      matched = true;
      if (seen[position.sourceIndex] === 1) continue;
      seen[position.sourceIndex] = 1;
      const path = prepared.paths[position.sourceIndex];
      if (path !== undefined) sources.push(path);
    }
    if (!matched) unmappedRanges += 1;
  }

  return { sources, unmappedRanges };
}

