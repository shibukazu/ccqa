import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileP } from "../drift/affected.ts";
import { createLastGreenResolver } from "./last-green.ts";

let repo: string;
let headSha: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "ccqa-last-green-"));
  const git = (...args: string[]) => execFileP("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  headSha = (await git("rev-parse", "HEAD")).stdout.trim();
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("createLastGreenResolver", () => {
  const spec = { featureName: "f", specName: "s" };

  test("resolves a ledger entry whose commit exists locally", async () => {
    const resolve = createLastGreenResolver({ "f/s": { gitHead: headSha, runId: "r1", at: "t" } }, repo);
    const r = await resolve(spec);
    expect(r).toEqual({ ok: true, base: { ref: "last-green", sha: headSha, source: "last-green" } });
  });

  test("a spec missing from the ledger skips with a 'not recorded yet' reason", async () => {
    const resolve = createLastGreenResolver({}, repo);
    const r = await resolve(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toMatch(/no last-green baseline/);
  });

  test("a ledger commit absent from the checkout skips with a fetch-depth hint", async () => {
    const resolve = createLastGreenResolver(
      { "f/s": { gitHead: "d".repeat(40), runId: "r1", at: "t" } },
      repo,
    );
    const r = await resolve(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toMatch(/fetch-depth/);
  });
});
