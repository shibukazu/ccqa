import { describe, expect, test } from "vitest";
import { splitPatchByFile } from "../report/diff.ts";
import { FILE_DIFF_RESPONSE_CAP, lookupFileDiff } from "./diff-provider.ts";

function makePatch(files: Record<string, string>): string {
  return Object.entries(files)
    .map(
      ([path, body]) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`,
    )
    .join("\n");
}

describe("lookupFileDiff", () => {
  const sections = splitPatchByFile(
    makePatch({ "src/a.ts": "+added line", "lib/config.ts": "+const x = 1;" }),
  );

  test("returns the named file's section, tolerating a leading ./", () => {
    expect(lookupFileDiff(sections, "lib/config.ts")).toContain("+const x = 1;");
    expect(lookupFileDiff(sections, "./lib/config.ts")).toContain("+const x = 1;");
  });

  test("returns null for a file not in the diff range", () => {
    expect(lookupFileDiff(sections, "src/missing.ts")).toBeNull();
  });

  test("caps an oversized hunk with a truncation note", () => {
    const big = splitPatchByFile(makePatch({ "gen.ts": "+x".repeat(FILE_DIFF_RESPONSE_CAP) }));
    const out = lookupFileDiff(big, "gen.ts")!;
    expect(out.length).toBeLessThan(FILE_DIFF_RESPONSE_CAP + 200);
    expect(out).toContain("[truncated:");
  });
});
