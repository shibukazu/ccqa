import { describe, expect, test } from "vitest";
import {
  compileGlob,
  parseGitDiffOutput,
  rerootChangedFiles,
} from "./affected.ts";

function matches(path: string, pattern: string): boolean {
  return compileGlob(pattern).test(path);
}

describe("compileGlob", () => {
  test("matches a literal path", () => {
    expect(matches("src/a.ts", "src/a.ts")).toBe(true);
    expect(matches("src/b.ts", "src/a.ts")).toBe(false);
  });

  test("** matches any depth", () => {
    expect(matches("src/features/tasks/page.tsx", "src/features/**")).toBe(true);
    expect(matches("src/features/tasks/nested/x.tsx", "src/features/**")).toBe(true);
    expect(matches("src/other/x.tsx", "src/features/**")).toBe(false);
  });

  test("** also matches the empty tail (no nested segment)", () => {
    expect(matches("src/features", "src/features/**")).toBe(true);
  });

  test("* does not cross path separators", () => {
    expect(matches("src/a.ts", "src/*.ts")).toBe(true);
    expect(matches("src/nested/a.ts", "src/*.ts")).toBe(false);
  });

  test("? matches a single non-slash char", () => {
    expect(matches("src/a.ts", "src/?.ts")).toBe(true);
    expect(matches("src/ab.ts", "src/?.ts")).toBe(false);
  });

  test("strips a leading ./ from the pattern", () => {
    expect(matches("src/a.ts", "./src/a.ts")).toBe(true);
  });

  test("special regex chars in pattern are escaped", () => {
    expect(matches("src/a.ts", "src/a.ts")).toBe(true);
    expect(matches("src/aXts", "src/a.ts")).toBe(false);
  });
});

describe("parseGitDiffOutput", () => {
  test("parses added, modified, deleted entries", () => {
    const stdout = "A\tsrc/new.ts\nM\tsrc/touched.ts\nD\tsrc/gone.ts\n";
    expect(parseGitDiffOutput(stdout)).toEqual([
      { path: "src/new.ts", status: "added" },
      { path: "src/touched.ts", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
    ]);
  });

  test("reports renames under the new path with 'renamed' status", () => {
    const stdout = "R100\tsrc/old.ts\tsrc/new.ts\n";
    expect(parseGitDiffOutput(stdout)).toEqual([
      { path: "src/new.ts", status: "renamed" },
    ]);
  });

  test("treats copies as added on the new path", () => {
    const stdout = "C75\tsrc/orig.ts\tsrc/copy.ts\n";
    expect(parseGitDiffOutput(stdout)).toEqual([
      { path: "src/copy.ts", status: "added" },
    ]);
  });

  test("skips blank lines", () => {
    expect(parseGitDiffOutput("\n\nA\tsrc/a.ts\n\n")).toEqual([
      { path: "src/a.ts", status: "added" },
    ]);
  });

  test("falls back to 'modified' for unknown status codes", () => {
    expect(parseGitDiffOutput("X\tsrc/weird.ts\n")).toEqual([
      { path: "src/weird.ts", status: "modified" },
    ]);
  });
});

describe("rerootChangedFiles", () => {
  test("returns entries unchanged when cwd equals repo root", () => {
    const entries = [
      { path: "src/a.ts", status: "modified" as const },
      { path: "src/b.ts", status: "added" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo")).toEqual(entries);
  });

  test("rewrites paths relative to cwd when cwd is a sub-package", () => {
    const entries = [
      { path: "js/apps/web/src/features/tasks/page.tsx", status: "modified" as const },
      { path: "js/apps/web/src/util.ts", status: "added" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo/js/apps/web")).toEqual([
      { path: "src/features/tasks/page.tsx", status: "modified" },
      { path: "src/util.ts", status: "added" },
    ]);
  });

  test("keeps entries outside cwd under their repo-root path, flagged outsideCwd", () => {
    const entries = [
      { path: "js/apps/web/src/a.ts", status: "modified" as const },
      { path: "js/apps/other/src/b.ts", status: "modified" as const },
      { path: "README.md", status: "modified" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo/js/apps/web")).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "js/apps/other/src/b.ts", status: "modified", outsideCwd: true },
      { path: "README.md", status: "modified", outsideCwd: true },
    ]);
  });

  test("a change to cwd itself (empty relative path) is kept as outsideCwd", () => {
    const entries = [
      { path: "js/apps/web", status: "modified" as const },
      { path: "js/apps/web/src/a.ts", status: "modified" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo/js/apps/web")).toEqual([
      { path: "js/apps/web", status: "modified", outsideCwd: true },
      { path: "src/a.ts", status: "modified" },
    ]);
  });
});
