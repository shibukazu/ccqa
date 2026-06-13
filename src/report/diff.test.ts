import { describe, expect, test } from "vitest";
import { scopePatchForSpec, splitPatchByFile } from "./diff.ts";

function fileSection(path: string, bodyLines: number): string {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `index 0000000..1111111 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${bodyLines} +1,${bodyLines} @@`,
  ];
  for (let i = 0; i < bodyLines; i++) lines.push(`+line ${i} of ${path}`);
  return lines.join("\n");
}

describe("splitPatchByFile", () => {
  test("splits on diff --git boundaries and keys on the b/ path", () => {
    const patch = [fileSection("src/a.ts", 2), fileSection("src/dir/b.ts", 3)].join("\n");
    const sections = splitPatchByFile(patch);
    expect(sections.map((s) => s.path)).toEqual(["src/a.ts", "src/dir/b.ts"]);
    expect(sections[0]!.body).toContain("+line 1 of src/a.ts");
    expect(sections[1]!.body).toContain("diff --git a/src/dir/b.ts");
  });

  test("uses the post-rename path for renames", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");
    expect(splitPatchByFile(patch).map((s) => s.path)).toEqual(["src/new.ts"]);
  });

  test("empty patch yields no sections", () => {
    expect(splitPatchByFile("")).toEqual([]);
  });
});

describe("scopePatchForSpec", () => {
  const patch = [
    fileSection("src/features/tasks/list.tsx", 2),
    fileSection("src/features/billing/invoice.tsx", 2),
  ].join("\n");

  test("keeps only sections matching relatedPaths globs", () => {
    const out = scopePatchForSpec(patch, ["src/features/tasks/**"]);
    expect(out).toContain("src/features/tasks/list.tsx");
    expect(out).not.toContain("billing");
  });

  test("null relatedPaths keeps the whole patch", () => {
    const out = scopePatchForSpec(patch, null);
    expect(out).toContain("tasks/list.tsx");
    expect(out).toContain("billing/invoice.tsx");
  });

  test("falls back to the full patch when nothing matches (PRODUCT_BUG signal needs the real diff)", () => {
    const out = scopePatchForSpec(patch, ["src/features/payments/**"]);
    expect(out).toContain("tasks/list.tsx");
    expect(out).toContain("billing/invoice.tsx");
  });

  test("truncates a single oversized file section with a marker", () => {
    const big = fileSection("src/huge.ts", 50);
    const out = scopePatchForSpec(big, null, { perFile: 200, total: 10_000 });
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[truncated:");
    expect(out).toContain("src/huge.ts");
  });

  test("stops emitting sections once the total cap is reached and reports the drop", () => {
    const many = Array.from({ length: 10 }, (_, i) => fileSection(`src/f${i}.ts`, 5)).join("\n");
    const out = scopePatchForSpec(many, null, { perFile: 10_000, total: 300 });
    expect(out).toContain("more changed file(s) omitted");
    expect(out.length).toBeLessThan(many.length);
  });
});
