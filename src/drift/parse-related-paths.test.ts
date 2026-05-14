import { describe, expect, test } from "vitest";
import { parseRelatedPathsBlock } from "./parse-related-paths.ts";

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
