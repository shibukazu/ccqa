import { describe, expect, it } from "vitest";

import type { CoverageConfig } from "../runtime-env.ts";
import { fileIdFor, shouldInstrument } from "./select.ts";

function config(root: string, include: string[]): CoverageConfig {
  return { enabled: true, ambientSpecId: undefined, root, include, debug: false };
}

describe("shouldInstrument", () => {
  it("excludes node_modules regardless of the include list", () => {
    const cfg = config("/repo", ["node_modules/some-pkg"]);
    expect(shouldInstrument("/repo/node_modules/some-pkg/index.js", cfg)).toBeUndefined();
  });

  it("excludes files outside the root, since fileIdFor can't relativize them", () => {
    const cfg = config("/repo", ["src"]);
    expect(shouldInstrument("/elsewhere/src/file.ts", cfg)).toBeUndefined();
  });

  it("only matches a full include-prefix segment, not a prefix of another directory name, and returns the file's id", () => {
    const cfg = config("/repo", ["src"]);
    expect(shouldInstrument("/repo/src/file.ts", cfg)).toBe("src/file.ts");
    expect(shouldInstrument("/repo/src2/file.ts", cfg)).toBeUndefined();
  });
});

describe("fileIdFor", () => {
  it("returns undefined for a file outside the root", () => {
    expect(fileIdFor("/elsewhere/file.ts", "/repo")).toBeUndefined();
  });

  it("returns a posix-separated path relative to the root", () => {
    expect(fileIdFor("/repo/src/nested/file.ts", "/repo")).toBe("src/nested/file.ts");
  });
});
