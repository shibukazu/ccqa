import { describe, expect, test } from "vitest";
import { normalizeSourcePath } from "./source-path.ts";

const ROOTS = { base: "/repo", root: "/repo" };

/** A workspace: the build runs in one package, answers are rooted above it. */
const WORKSPACE = { base: "/repo/apps/web", root: "/repo" };

describe("normalizeSourcePath", () => {
  test("strips the bundler scheme and namespace, leaving a project-relative path", () => {
    expect(normalizeSourcePath("webpack://_N_E/./src/a.ts", ROOTS)).toEqual({
      kind: "project",
      path: "src/a.ts",
    });
  });

  test("strips the build-layer marker (e.g. `(pages-dir-browser)`)", () => {
    expect(normalizeSourcePath("webpack-internal:///(pages-dir-browser)/./src/a.ts", ROOTS)).toEqual(
      { kind: "project", path: "src/a.ts" },
    );
  });

  test("collapses a mid-path `..` segment", () => {
    expect(normalizeSourcePath("webpack://x/./src/a/../b.ts", ROOTS)).toEqual({
      kind: "project",
      path: "src/b.ts",
    });
  });

  test("reports a path resolving outside the root as unresolved, rather than flattening it", () => {
    expect(normalizeSourcePath("webpack://_N_E/../outside.ts", ROOTS).kind).toBe("unresolved");
    expect(normalizeSourcePath("/somewhere/else/src/a.ts", ROOTS).kind).toBe("unresolved");
  });

  // `file:///abs` has an empty authority; treating the first slash as the end
  // of a namespace turns an absolute path into a relative one.
  test("keeps the path of a scheme with no authority", () => {
    expect(normalizeSourcePath("file:///repo/src/a.ts", ROOTS)).toEqual({
      kind: "project",
      path: "src/a.ts",
    });
  });

  test("separates dependency code from names it could not place", () => {
    expect(normalizeSourcePath("webpack://_N_E/./node_modules/dep/index.js", ROOTS).kind).toBe(
      "dependency",
    );
    expect(normalizeSourcePath("<anonymous>", ROOTS).kind).toBe("unresolved");
  });

  test("anchors a Turbopack `[project]` name at the root, not the build directory", () => {
    expect(normalizeSourcePath("turbopack:///[project]/apps/web/src/a.ts", WORKSPACE)).toEqual({
      kind: "project",
      path: "apps/web/src/a.ts",
    });
  });

  test("leaves a Turbopack module identifier unresolved, not a file nobody can open", () => {
    const raw = "turbopack:///[project]/apps/web/src/a.tsx [app-client] (ecmascript)";
    expect(normalizeSourcePath(raw, WORKSPACE).kind).toBe("unresolved");
  });

  test("leaves Turbopack's other roots unresolved", () => {
    expect(normalizeSourcePath("turbopack:///[output]/chunk.js", ROOTS).kind).toBe("unresolved");
  });

  // The bundler names a sibling package relative to where it ran, so the two
  // roots have to be read apart: against the build directory it resolves, and
  // against the root it becomes a path a reader can open.
  test("resolves a sibling workspace package against the build directory", () => {
    const raw = "webpack-internal:///(app-pages-browser)/../../packages/logger/dist/index.mjs";
    expect(normalizeSourcePath(raw, WORKSPACE)).toEqual({
      kind: "project",
      path: "packages/logger/dist/index.mjs",
    });
    // Same name, root left at the package: it leaves the root and is lost.
    expect(normalizeSourcePath(raw, { base: WORKSPACE.base, root: WORKSPACE.base }).kind).toBe(
      "unresolved",
    );
  });
});
