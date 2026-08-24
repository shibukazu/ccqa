import { describe, expect, it } from "vitest";
import { reduceSourceMap } from "./reduce-map.ts";

describe("reduceSourceMap", () => {
  it("drops the original source, which no reader consults", () => {
    const reduced = reduceSourceMap(
      JSON.stringify({
        version: 3,
        file: "a.js",
        sources: ["src/a.ts"],
        sourcesContent: ["the entire original file"],
        mappings: "AAAA",
      }),
    );
    expect(reduced).toEqual({ version: 3, file: "a.js", sources: ["src/a.ts"], mappings: "AAAA" });
    expect(JSON.stringify(reduced)).not.toContain("the entire original file");
  });

  it("keeps sourceRoot, which paths are resolved against", () => {
    const reduced = reduceSourceMap(JSON.stringify({ version: 3, sourceRoot: "../", sources: ["a.ts"], mappings: "A" }));
    expect(reduced?.sourceRoot).toBe("../");
  });

  it("refuses what the reader would refuse, so an unusable map is never stored", () => {
    expect(reduceSourceMap("not json")).toBeUndefined();
    expect(reduceSourceMap(JSON.stringify({ version: 2, sources: [], mappings: "" }))).toBeUndefined();
    expect(reduceSourceMap(JSON.stringify({ version: 3, sources: [] }))).toBeUndefined();
    // Section maps need a different decoder; refused whole.
    expect(reduceSourceMap(JSON.stringify({ version: 3, sections: [], sources: [], mappings: "" }))).toBeUndefined();
  });
});
