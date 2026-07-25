import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileP } from "../drift/affected.ts";
import { countUnmatchedPatterns, listCheckoutFiles, walkFiles } from "./related-paths-check.ts";

let root: string;

async function seed(dir: string): Promise<void> {
  await mkdir(join(dir, "src/features/auth"), { recursive: true });
  await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
  await mkdir(join(dir, ".git/objects"), { recursive: true });
  await writeFile(join(dir, "src/features/auth/login.tsx"), "");
  await writeFile(join(dir, "src/index.ts"), "");
  await writeFile(join(dir, "node_modules/pkg/index.js"), "");
  await writeFile(join(dir, ".git/objects/blob"), "");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ccqa-related-paths-"));
  await seed(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listCheckoutFiles", () => {
  test("lists tracked files as cwd-relative posix paths", async () => {
    const git = (...args: string[]) =>
      execFileP("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd: root });
    await git("init", "-q", "-b", "main");
    await git("add", "src");
    await git("commit", "-q", "-m", "init");
    // The untracked file is absent: `relatedPaths` are only ever matched
    // against `git diff` output, which never names one.
    await writeFile(join(root, "src/untracked.ts"), "");
    expect((await listCheckoutFiles(root)).sort()).toEqual([
      "src/features/auth/login.tsx",
      "src/index.ts",
    ]);
  });

  test("the non-git fallback walk skips .git and node_modules", async () => {
    expect((await walkFiles(root)).filter((f) => !f.startsWith(".git/")).sort()).toEqual([
      "src/features/auth/login.tsx",
      "src/index.ts",
      "src/untracked.ts",
    ]);
  });
});

describe("countUnmatchedPatterns", () => {
  const files = ["src/features/auth/login.tsx", "src/index.ts"];

  test("counts nothing when every pattern matches a file", () => {
    expect(countUnmatchedPatterns(["src/features/**", "src/index.ts"], files)).toBe(0);
  });

  test("counts a pattern that matches no file — the signal a spec is too narrowly scoped", () => {
    expect(countUnmatchedPatterns(["src/features/**", "app/legacy/**"], files)).toBe(1);
  });

  test("counts every unmatched pattern, not just the first", () => {
    expect(countUnmatchedPatterns(["a/**", "b/**", "src/**"], files)).toBe(2);
  });

  test("no patterns means nothing to flag", () => {
    expect(countUnmatchedPatterns([], files)).toBe(0);
  });
});
