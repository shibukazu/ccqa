import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONVENTIONS_MAX_BYTES,
  expandPatternToFiles,
  globBase,
  loadConventions,
  resolvePackageRoot,
  resolveResources,
} from "./resources.ts";

let cwd: string;

async function makeProject(files: Record<string, string>): Promise<string> {
  // realpath: on macOS the tmpdir lives behind a /var → /private/var symlink,
  // and require.resolve returns real paths — keep both sides comparable.
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-resources-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return cwd;
}

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("globBase", () => {
  it("returns the static prefix before the first wildcard segment", () => {
    expect(globBase("e2e/pages/**/*.ts")).toBe("e2e/pages");
    expect(globBase("e2e/*.ts")).toBe("e2e");
    expect(globBase("**/*.ts")).toBe(".");
    expect(globBase("docs/guide.md")).toBe("docs/guide.md");
  });
});

describe("expandPatternToFiles", () => {
  it("expands ** and * patterns to matching files, skipping node_modules", async () => {
    await makeProject({
      "e2e/pages/todo_list.ts": "",
      "e2e/pages/nested/detail.ts": "",
      "e2e/pages/readme.md": "",
      "e2e/pages/node_modules/dep/index.ts": "",
    });
    expect(await expandPatternToFiles(cwd, "e2e/pages/**/*.ts")).toEqual([
      "e2e/pages/nested/detail.ts",
      "e2e/pages/todo_list.ts",
    ]);
    expect(await expandPatternToFiles(cwd, "e2e/pages/*.md")).toEqual(["e2e/pages/readme.md"]);
  });

  it("expands a literal directory to every file under it", async () => {
    await makeProject({ "e2e/steps/login.ts": "", "e2e/steps/nested/logout.ts": "" });
    expect(await expandPatternToFiles(cwd, "e2e/steps")).toEqual([
      "e2e/steps/login.ts",
      "e2e/steps/nested/logout.ts",
    ]);
  });

  it("passes a literal file through", async () => {
    await makeProject({ "docs/guide.md": "x" });
    expect(await expandPatternToFiles(cwd, "docs/guide.md")).toEqual(["docs/guide.md"]);
  });

  it("throws on a missing literal path and on a matchless glob", async () => {
    await makeProject({ "e2e/pages/todo_list.ts": "" });
    await expect(expandPatternToFiles(cwd, "docs/guide.md")).rejects.toThrow(/does not exist/);
    await expect(expandPatternToFiles(cwd, "e2e/pages/*.spec.ts")).rejects.toThrow(
      /matches no files/,
    );
    await expect(expandPatternToFiles(cwd, "missing/**/*.ts")).rejects.toThrow(
      /base directory missing does not exist/,
    );
  });
});

describe("resolvePackageRoot", () => {
  it("resolves an installed package directory from node_modules", async () => {
    await makeProject({
      "node_modules/@acme/e2e-kit/package.json": JSON.stringify({ name: "@acme/e2e-kit" }),
      "node_modules/@acme/e2e-kit/index.d.ts": "export {};",
    });
    expect(await resolvePackageRoot(cwd, "@acme/e2e-kit")).toBe(
      resolve(cwd, "node_modules/@acme/e2e-kit"),
    );
  });

  it("throws for an uninstalled package", async () => {
    await makeProject({});
    await expect(resolvePackageRoot(cwd, "@acme/nowhere-kit")).rejects.toThrow(
      /"@acme\/nowhere-kit" could not be resolved/,
    );
  });
});

describe("resolveResources", () => {
  it("resolves path and package resources with their write policies", async () => {
    await makeProject({
      "e2e/pages/todo_list.ts": "",
      "node_modules/@acme/e2e-kit/package.json": JSON.stringify({ name: "@acme/e2e-kit" }),
    });
    const resolved = await resolveResources(cwd, [
      { path: "e2e/pages/**/*.ts", description: "page objects" },
      { package: "@acme/e2e-kit" },
    ]);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      kind: "path",
      rootDisplay: "e2e/pages",
      rootAbs: resolve(cwd, "e2e/pages"),
      writable: true,
      description: "page objects",
    });
    expect(resolved[1]).toMatchObject({
      kind: "package",
      rootAbs: resolve(cwd, "node_modules/@acme/e2e-kit"),
      writable: false,
    });
  });

  it("hard-errors on an unresolvable resource instead of skipping it", async () => {
    await makeProject({});
    await expect(resolveResources(cwd, [{ path: "e2e/pages" }])).rejects.toThrow(
      /resource path "e2e\/pages" does not exist/,
    );
    await expect(resolveResources(cwd, [{ package: "@acme/e2e-kit" }])).rejects.toThrow(
      /could not be resolved/,
    );
  });
});

describe("loadConventions", () => {
  it("loads guide and example bodies in declared order", async () => {
    await makeProject({
      "docs/style.md": "guide body",
      "e2e/sample.spec.ts": "example body",
    });
    const { sections, warnings } = await loadConventions(cwd, {
      guides: ["docs/style.md"],
      examples: ["e2e/sample.spec.ts"],
    });
    expect(sections.map((s) => s.path)).toEqual(["docs/style.md", "e2e/sample.spec.ts"]);
    expect(sections[0]!.body).toBe("guide body");
    expect(warnings).toEqual([]);
  });

  it("drops whole files over the byte budget and names them in a warning", async () => {
    await makeProject({
      "docs/a.md": "a".repeat(60),
      "docs/b.md": "b".repeat(60),
      "docs/c.md": "c".repeat(30),
    });
    const { sections, warnings } = await loadConventions(
      cwd,
      { guides: ["docs/a.md", "docs/b.md", "docs/c.md"], examples: [] },
      100,
    );
    // a fits (60), b would exceed (120) and is dropped whole, c still fits (90).
    expect(sections.map((s) => s.path)).toEqual(["docs/a.md", "docs/c.md"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/dropped: docs\/b\.md \(60 bytes\)/);
  });

  it("truncates (with a warning) only when the first file alone exceeds the budget", async () => {
    await makeProject({ "docs/huge.md": "x".repeat(200) });
    const { sections, warnings } = await loadConventions(
      cwd,
      { guides: ["docs/huge.md"], examples: [] },
      100,
    );
    expect(sections[0]!.body).toHaveLength(100);
    expect(warnings[0]).toMatch(/docs\/huge\.md exceeds the 100-byte prompt budget/);
  });

  it("errors on a conventions entry that matches nothing", async () => {
    await makeProject({});
    await expect(
      loadConventions(cwd, { guides: ["docs/style.md"], examples: [] }),
    ).rejects.toThrow(/conventions entry "docs\/style\.md" does not exist/);
  });

  it("exports a sane default budget", () => {
    expect(CONVENTIONS_MAX_BYTES).toBe(64 * 1024);
  });
});
