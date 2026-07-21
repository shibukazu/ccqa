import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileP } from "../drift/affected.ts";
import { RunUsageError } from "./errors.ts";
import { resolveAnalysisBase, resolveGitContext } from "./git-context.ts";

let repo: string;
let headSha: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "ccqa-git-context-"));
  const git = (...args: string[]) => execFileP("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  headSha = (await git("rev-parse", "HEAD")).stdout.trim();
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

const ORIGINAL = process.env["GITHUB_BASE_REF"];
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env["GITHUB_BASE_REF"];
  else process.env["GITHUB_BASE_REF"] = ORIGINAL;
});

describe("resolveAnalysisBase", () => {
  test("explicit ref resolves to its sha with source 'explicit'", async () => {
    delete process.env["GITHUB_BASE_REF"];
    const base = await resolveAnalysisBase("main", "--failure-analysis", repo);
    expect(base).toEqual({ ref: "main", sha: headSha, source: "explicit" });
  });

  test("bare flag without GITHUB_BASE_REF is a usage error naming the flag", async () => {
    delete process.env["GITHUB_BASE_REF"];
    await expect(resolveAnalysisBase(true, "--changed", repo)).rejects.toThrow(RunUsageError);
    await expect(resolveAnalysisBase(true, "--changed", repo)).rejects.toThrow(/--changed/);
  });

  test("bare flag derives the ref from GITHUB_BASE_REF, prefixing origin/", async () => {
    process.env["GITHUB_BASE_REF"] = "main";
    // origin/main doesn't exist in this repo — the point is the derived ref
    // in the error message, proving the env var was picked up and prefixed.
    await expect(resolveAnalysisBase(true, "--failure-analysis", repo)).rejects.toThrow(
      /'origin\/main' is not a resolvable git ref/,
    );
  });

  test("an unresolvable explicit ref is a usage error with a fetch-depth hint", async () => {
    delete process.env["GITHUB_BASE_REF"];
    await expect(resolveAnalysisBase("no-such-ref", "--failure-analysis", repo)).rejects.toThrow(
      /fetch-depth/,
    );
  });
});

describe("resolveGitContext", () => {
  test("head is recorded even when analysis is not requested", async () => {
    const ctx = await resolveGitContext(undefined, repo);
    expect(ctx).toEqual({ head: headSha, base: null });
  });

  test("head degrades to null outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-not-a-repo-"));
    try {
      const ctx = await resolveGitContext(undefined, dir);
      expect(ctx.head).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
