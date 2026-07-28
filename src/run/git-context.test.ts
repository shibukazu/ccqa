import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileP } from "../drift/affected.ts";
import { RunUsageError } from "./errors.ts";
import { resolveAnalysisBase } from "./git-context.ts";

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

describe("resolveAnalysisBase", () => {
  test("a ref resolves to its sha", async () => {
    const base = await resolveAnalysisBase("main", "--on-fail-explain-base", repo);
    expect(base).toEqual({ ref: "main", sha: headSha, source: "explicit" });
  });

  test("an unresolvable ref is a usage error with a fetch-depth hint", async () => {
    await expect(resolveAnalysisBase("no-such-ref", "--on-fail-explain-base", repo)).rejects.toThrow(
      RunUsageError,
    );
    await expect(resolveAnalysisBase("no-such-ref", "--on-fail-explain-base", repo)).rejects.toThrow(
      /fetch-depth/,
    );
  });
});
