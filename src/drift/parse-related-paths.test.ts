import { describe, expect, test } from "vitest";
import { normalizeRelatedPaths, parseRelatedPathsBlock } from "./parse-related-paths.ts";

describe("parseRelatedPathsBlock", () => {
  test("returns null when no block is present", () => {
    expect(parseRelatedPathsBlock("just some text\nno block here")).toBeNull();
  });

  test("returns empty array for an empty block", () => {
    const text = "preamble\nRELATED_PATHS_BEGIN\nRELATED_PATHS_END\ntrailer";
    expect(parseRelatedPathsBlock(text)).toEqual([]);
  });

  test("extracts paths line by line", () => {
    const text = `chatter
RELATED_PATHS_BEGIN
src/features/tasks/**
src/app/tasks/page.tsx
RELATED_PATHS_END
trailing`;
    expect(parseRelatedPathsBlock(text)).toEqual([
      "src/features/tasks/**",
      "src/app/tasks/page.tsx",
    ]);
  });

  test("tolerates leading dash bullets and surrounding whitespace", () => {
    const text = `RELATED_PATHS_BEGIN
- src/a.ts
  - src/b.ts
* src/c.ts
RELATED_PATHS_END`;
    expect(parseRelatedPathsBlock(text)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("deduplicates entries", () => {
    const text = `RELATED_PATHS_BEGIN
src/a.ts
src/a.ts
src/b.ts
RELATED_PATHS_END`;
    expect(parseRelatedPathsBlock(text)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("ignores code fence lines inside the block", () => {
    const text = `RELATED_PATHS_BEGIN
\`\`\`
src/a.ts
\`\`\`
RELATED_PATHS_END`;
    expect(parseRelatedPathsBlock(text)).toEqual(["src/a.ts"]);
  });
});

describe("normalizeRelatedPaths", () => {
  const norm = (paths: string[], prefix: string | null) => normalizeRelatedPaths(paths, prefix);

  test("strips the cwd prefix from repo-root-form in-app entries", () => {
    const r = norm(["apps/foo/src/features/x/**", "src/app/y/page.tsx"], "apps/foo");
    expect(r.paths).toEqual(["src/features/x/**", "src/app/y/page.tsx"]);
    expect(r.warnings).toEqual([]);
  });

  test("re-expresses ../ escapes as repo-root-relative globs", () => {
    const r = norm(["../../packages/ui-kit/**"], "js/apps/foo");
    expect(r.paths).toEqual(["js/packages/ui-kit/**"]);
  });

  test("drops entries escaping the repo (or ../ with unknown prefix) with a warning", () => {
    expect(norm(["../../../outside/**"], "apps/foo").warnings).toHaveLength(1);
    expect(norm(["../sibling/**"], null).warnings).toHaveLength(1);
    expect(norm(["../sibling/**"], "").warnings).toHaveLength(1);
  });

  test("keeps repo-root-relative cross-package globs and dedupes after normalization", () => {
    const r = norm(["packages/ui-kit/**", "apps/foo/src/x.ts", "src/x.ts"], "apps/foo");
    expect(r.paths).toEqual(["packages/ui-kit/**", "src/x.ts"]);
  });
});
