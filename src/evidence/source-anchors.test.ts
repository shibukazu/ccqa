import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSourceAnchors } from "./source-anchors.ts";
import type { SourceRoot } from "../config/source-roots.ts";

let cwd: string;

async function makeRoot(files: Record<string, string>): Promise<SourceRoot> {
  // realpath: on macOS the tmpdir lives behind a /var → /private/var symlink.
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-source-anchors-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return { configured: "src", abs: cwd };
}

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("findSourceAnchors", () => {
  it("finds the first file:line containing the needle as a substring", async () => {
    const root = await makeRoot({
      "components/Form.tsx": 'export const Form = () => <button data-testid="submit">Go</button>;',
    });
    const { found } = await findSourceAnchors(["submit"], [root]);
    expect(found.get("submit")).toEqual({
      needle: "submit",
      at: "src/components/Form.tsx:1",
    });
  });

  it("skips node_modules, .git, dist, build, coverage, .next and dotted directories", async () => {
    // Nothing outside a skipped directory contains the needle, so it is only
    // found at all if the walker wrongly descends into one of them.
    const root = await makeRoot({
      "node_modules/dep/index.ts": 'const submit = "submit";',
      ".git/hooks/pre-commit.ts": 'const submit = "submit";',
      "dist/bundle.js": 'const submit = "submit";',
      "build/out.js": 'const submit = "submit";',
      "coverage/report.js": 'const submit = "submit";',
      ".next/cache.js": 'const submit = "submit";',
      ".hidden/file.ts": 'const submit = "submit";',
      "real.ts": "const other = 1;",
    });
    const { found } = await findSourceAnchors(["submit"], [root]);
    expect(found.has("submit")).toBe(false);
  });

  it("only reads files with an allowlisted source extension", async () => {
    const root = await makeRoot({
      "notes.txt": 'const submit = "submit";',
      "styles.css": '.submit { color: red; }',
      "app.ts": 'const submit = "submit";',
    });
    const { found } = await findSourceAnchors(["submit"], [root]);
    expect(found.get("submit")?.at).toBe("src/app.ts:1");
  });

  it("skips files larger than maxFileBytes", async () => {
    const root = await makeRoot({
      "big.ts": `const submit = "submit"; // ${"x".repeat(100)}`,
      "small.ts": 'const submit = "submit";',
    });
    const { found } = await findSourceAnchors(["submit"], [root], { maxFileBytes: 50 });
    expect(found.get("submit")?.at).toBe("src/small.ts:1");
  });

  it("stops after maxFiles files, leaving later needles unresolved", async () => {
    const root = await makeRoot({
      "a.ts": "const one = 1;",
      "b.ts": "const two = 2;",
      "c.ts": 'const submit = "submit";',
    });
    // Breadth-first, alphabetical within a level: a.ts, b.ts read; c.ts never opened.
    const { found, unsearched } = await findSourceAnchors(["submit"], [root], { maxFiles: 2 });
    expect(found.has("submit")).toBe(false);
    // Stopping early is not a result: the reviewer must not read this as
    // "the product does not contain this string".
    expect(unsearched.has("submit")).toBe(true);
  });

  it("does not re-search a later root for a needle an earlier root already resolved", async () => {
    const rootA = await makeRoot({ "a.ts": 'const submit = "submit";' });
    const cwdA = cwd;
    const rootB = await makeRoot({ "b.ts": 'const submit = "submit";' });
    try {
      const { found } = await findSourceAnchors(
        ["submit"],
        [
          { configured: "root-a", abs: cwdA },
          { configured: "root-b", abs: rootB.abs },
        ],
      );
      expect(found.get("submit")?.at).toBe("root-a/a.ts:1");
    } finally {
      await rm(cwdA, { recursive: true, force: true });
    }
  });

  it("ignores needles shorter than 3 characters and blank needles", async () => {
    const root = await makeRoot({ "app.ts": 'const ok = "ok"; const x = "  ";' });
    const { found, unsearched } = await findSourceAnchors(["ok", "  "], [root]);
    expect(found.size).toBe(0);
    expect([...unsearched].sort()).toEqual(["  ", "ok"]);
  });
});
