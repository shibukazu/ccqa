import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FrontendResolution, type AcquiredScript } from "./resolve.ts";

const dirs: string[] = [];

function makeResolution(opts?: {
  fetchText?: (url: string) => Promise<string | undefined>;
  fetchStoredMap?: (mapUrl: string, scriptUrl: string) => Promise<string | undefined>;
}): { resolution: FrontendResolution; dir: string; warnings: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ccqa-resolve-"));
  dirs.push(dir);
  const warnings: string[] = [];
  const resolution = new FrontendResolution({
    specId: "run1.feature/spec",
    coverageDir: dir,
    roots: { base: dir, root: dir },
    fetchText: opts?.fetchText ?? (async () => undefined),
    fetchStoredMap: opts?.fetchStoredMap,
    warn: (text) => warnings.push(text),
  });
  return { resolution, dir, warnings };
}

function written(dir: string): {
  files: string[];
  unmappedScripts: number;
  stopped: boolean;
} {
  return JSON.parse(readFileSync(join(dir, "coverage-frontend.json"), "utf8")) as ReturnType<
    typeof written
  >;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const covered = (url: string, source?: string): AcquiredScript => ({
  url,
  ranges: [{ startOffset: 0, endOffset: 10 }],
  source: async () => source,
});

describe("FrontendResolution", () => {
  it("takes the bundler-URL fast path without ever fetching the source", async () => {
    const { resolution, dir } = makeResolution({
      fetchText: async () => {
        throw new Error("must not be called");
      },
    });
    await resolution.absorb({
      url: "webpack://app/./src/feature.ts",
      ranges: [{ startOffset: 0, endOffset: 5 }],
      source: async () => {
        throw new Error("the direct path must not need the source");
      },
    });
    resolution.flush();
    expect(written(dir).files).toEqual(["src/feature.ts"]);
  });

  it("ignores a script with no covered ranges", async () => {
    const { resolution, dir } = makeResolution();
    await resolution.absorb({
      url: "webpack://app/./src/unreached.ts",
      ranges: [],
      source: async () => undefined,
    });
    resolution.flush();
    expect(written(dir).files).toEqual([]);
  });

  it("resolves an http script through its source map", async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["webpack://app/./src/mapped.ts"],
      names: [],
      mappings: "AAAA",
    });
    const source = `covered();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}`;
    const { resolution, dir } = makeResolution();
    await resolution.absorb(covered("http://127.0.0.1:1/app.js", source));
    resolution.flush();
    expect(written(dir).files).toEqual(["src/mapped.ts"]);
  });

  it("asks the store for the map the script points at, not for <chunk>.js.map", async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ["webpack://app/./src/stored.ts"],
      names: [],
      mappings: "AAAA",
    });
    const asked: [string, string][] = [];
    const { resolution, dir } = makeResolution({
      fetchStoredMap: async (mapUrl, scriptUrl) => {
        asked.push([mapUrl, scriptUrl]);
        return map;
      },
    });
    await resolution.absorb(
      covered("http://127.0.0.1:1/chunk.js", "covered();\n//# sourceMappingURL=other-name.js.map"),
    );
    resolution.flush();
    // The script URL rides along so the store can still be asked when the
    // pointer names an origin this run never declared.
    expect(asked).toEqual([["http://127.0.0.1:1/other-name.js.map", "http://127.0.0.1:1/chunk.js"]]);
    expect(written(dir).files).toEqual(["src/stored.ts"]);
  });

  it("falls back to the script's own URL when it points at no map", async () => {
    const asked: string[] = [];
    const { resolution } = makeResolution({
      fetchStoredMap: async (mapUrl) => {
        asked.push(mapUrl);
        return undefined;
      },
    });
    await resolution.absorb(covered("http://127.0.0.1:1/chunk.js", "covered();"));
    resolution.flush();
    expect(asked).toEqual(["http://127.0.0.1:1/chunk.js"]);
  });

  it("counts an http script with no map as unmapped, not as reached nothing", async () => {
    const { resolution, dir } = makeResolution();
    await resolution.absorb(covered("http://127.0.0.1:1/plain.js", "covered();"));
    resolution.flush();
    const result = written(dir);
    expect(result.files).toEqual([]);
    expect(result.unmappedScripts).toBe(1);
  });

  it("marks the result stopped when collection dies mid-spec", async () => {
    const { resolution, dir } = makeResolution();
    await resolution.absorb(covered("webpack://app/./src/a.ts"));
    resolution.markStopped();
    const result = written(dir);
    expect(result.stopped).toBe(true);
    expect(result.files).toEqual(["src/a.ts"]);
  });
});
