import { describe, expect, test } from "vitest";
import {
  parseSourceMap,
  prepareSourceMap,
  readSourceMappingUrl,
  resolveCovered,
  type CoveredRange,
  type RawSourceMap,
  type SourceResolution,
} from "./source-map.ts";

/**
 * What production does in two steps, in one. Production keeps the prepared map
 * because it resolves against it at every navigation; a test has one shot.
 */
function resolveCoveredSources(
  map: RawSourceMap,
  generatedCode: string,
  ranges: readonly CoveredRange[],
): SourceResolution {
  const prepared = prepareSourceMap(map, generatedCode);
  if (prepared === undefined) return { sources: [], unmappedRanges: ranges.length };
  return resolveCovered(prepared, ranges);
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encodes one VLQ field, mirroring what a real source map generator emits. */
function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 0x1f;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0x20;
    out += BASE64_CHARS.charAt(digit);
  } while (vlq > 0);
  return out;
}

/** Builds a `mappings` string from per-line segments of field deltas, so tests express intent (deltas) instead of hand-typed base64. */
function buildMappings(lines: number[][][]): string {
  return lines.map((segments) => segments.map((fields) => fields.map(encodeVlq).join("")).join(",")).join(";");
}

function rawMap(fields: { sources: (string | null)[]; mappings: string; sourceRoot?: string }): RawSourceMap {
  return { version: 3, ...fields };
}

describe("parseSourceMap", () => {
  test("rejects index maps (sections) instead of partially decoding them", () => {
    const json = JSON.stringify({ version: 3, sources: [], mappings: "", sections: [] });
    expect(parseSourceMap(json)).toBeUndefined();
  });
});

describe("resolveCoveredSources", () => {
  // Two bundled modules, one mapping segment per line: line 0 -> a.ts (source
  // index 0), line 1 -> b.ts (source index 1).
  const generatedCode = "AAA();\nBBB();\n";
  const map = rawMap({
    sources: ["a.ts", "b.ts"],
    mappings: buildMappings([[[0, 0, 0, 0]], [[0, 1, 0, 0]]]),
  });

  test("resolves only the sources touched by covered ranges, not the whole map", () => {
    const result = resolveCoveredSources(map, generatedCode, [{ startOffset: 0, endOffset: 6 }]);
    expect(result.sources).toEqual(["a.ts"]);
  });

  test("counts a range with no matching mapping as unmapped rather than covered", () => {
    const result = resolveCoveredSources(map, generatedCode, [{ startOffset: 1000, endOffset: 1010 }]);
    expect(result.sources).toEqual([]);
    expect(result.unmappedRanges).toBe(1);
  });

  test("decodes negative and multi-digit (continuation-bit) VLQ deltas", () => {
    // Third line's segment: generatedColumn +37 (exceeds 5 bits, so it needs
    // a continuation digit), sourceIndex -1 (back from b.ts to a.ts). Wrong
    // decoding of either field resolves to the wrong source, or none.
    const code = "AAA();\nBBB();\nCCC();\n";
    const threeLineMap = rawMap({
      sources: ["a.ts", "b.ts"],
      mappings: buildMappings([[[0, 0, 0, 0]], [[0, 1, 0, 0]], [[37, -1, 0, 0]]]),
    });
    const lineTwoStart = code.indexOf("CCC");
    const result = resolveCoveredSources(threeLineMap, code, [
      { startOffset: lineTwoStart + 37, endOffset: lineTwoStart + 38 },
    ]);
    expect(result.sources).toEqual(["a.ts"]);
  });
});

describe("sourceRoot", () => {
  test("is prepended to each source without duplicating the slash", () => {
    const map = rawMap({
      sourceRoot: "lib/",
      sources: ["app.ts"],
      mappings: buildMappings([[[0, 0, 0, 0]]]),
    });
    const result = resolveCoveredSources(map, "AAA();\n", [{ startOffset: 0, endOffset: 6 }]);
    expect(result.sources).toEqual(["lib/app.ts"]);
  });
});

describe("readSourceMappingUrl", () => {
  test("picks the trailing sourceMappingURL comment, or undefined if there isn't one", () => {
    expect(readSourceMappingUrl("var x = 1;\n//# sourceMappingURL=x.js.map\n")).toBe("x.js.map");
    expect(readSourceMappingUrl("var x = 1;")).toBeUndefined();
  });
});
