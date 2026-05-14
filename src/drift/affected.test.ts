import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isPathAffectedBy,
  matchesGlob,
  parseGitDiffOutput,
  rerootChangedFiles,
  resolveBaseRef,
} from "./affected.ts";

describe("matchesGlob", () => {
  test("matches a literal path", () => {
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/b.ts")).toBe(false);
  });

  test("** matches any depth", () => {
    expect(matchesGlob("src/features/tasks/page.tsx", "src/features/**")).toBe(true);
    expect(matchesGlob("src/features/tasks/nested/x.tsx", "src/features/**")).toBe(true);
    expect(matchesGlob("src/other/x.tsx", "src/features/**")).toBe(false);
  });

  test("** also matches the empty tail (no nested segment)", () => {
    expect(matchesGlob("src/features", "src/features/**")).toBe(true);
  });

  test("* does not cross path separators", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/nested/a.ts", "src/*.ts")).toBe(false);
  });

  test("? matches a single non-slash char", () => {
    expect(matchesGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchesGlob("src/ab.ts", "src/?.ts")).toBe(false);
  });

  test("ignores leading ./ on both sides", () => {
    expect(matchesGlob("./src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "./src/a.ts")).toBe(true);
  });

  test("special regex chars in pattern are escaped", () => {
    expect(matchesGlob("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/aXts", "src/a.ts")).toBe(false);
  });
});

describe("isPathAffectedBy", () => {
  test("returns true when any pattern matches", () => {
    expect(
      isPathAffectedBy("src/features/tasks/page.tsx", [
        "src/auth/**",
        "src/features/tasks/**",
      ]),
    ).toBe(true);
  });

  test("returns false when no pattern matches", () => {
    expect(
      isPathAffectedBy("src/other/x.tsx", [
        "src/auth/**",
        "src/features/tasks/**",
      ]),
    ).toBe(false);
  });

  test("returns false for empty patterns", () => {
    expect(isPathAffectedBy("anything", [])).toBe(false);
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

  test("drops entries outside cwd", () => {
    const entries = [
      { path: "js/apps/web/src/a.ts", status: "modified" as const },
      { path: "js/apps/other/src/b.ts", status: "modified" as const },
      { path: "README.md", status: "modified" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo/js/apps/web")).toEqual([
      { path: "src/a.ts", status: "modified" },
    ]);
  });

  test("drops a change to cwd itself (empty relative path)", () => {
    const entries = [
      { path: "js/apps/web", status: "modified" as const },
      { path: "js/apps/web/src/a.ts", status: "modified" as const },
    ];
    expect(rerootChangedFiles(entries, "/repo", "/repo/js/apps/web")).toEqual([
      { path: "src/a.ts", status: "modified" },
    ]);
  });
});

describe("resolveBaseRef", () => {
  const ORIGINAL = process.env["GITHUB_BASE_REF"];
  beforeEach(() => {
    delete process.env["GITHUB_BASE_REF"];
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["GITHUB_BASE_REF"];
    else process.env["GITHUB_BASE_REF"] = ORIGINAL;
  });

  test("returns the explicit override unchanged", () => {
    expect(resolveBaseRef("main")).toBe("main");
    expect(resolveBaseRef("origin/develop")).toBe("origin/develop");
  });

  test("uses GITHUB_BASE_REF when no override is given, prefixing origin/", () => {
    process.env["GITHUB_BASE_REF"] = "main";
    expect(resolveBaseRef(undefined)).toBe("origin/main");
  });

  test("does not double-prefix GITHUB_BASE_REF that already has origin/", () => {
    process.env["GITHUB_BASE_REF"] = "origin/main";
    expect(resolveBaseRef(undefined)).toBe("origin/main");
  });

  test("falls back to origin/main when nothing is set", () => {
    expect(resolveBaseRef(undefined)).toBe("origin/main");
  });
});
