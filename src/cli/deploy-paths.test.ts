import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileP } from "../drift/affected.ts";
import { MAX_RETAINED_CHANGED_PATHS } from "../hub/core/deploy-log.ts";
import { capDeployPaths, changedPathsBetween, MAX_SENT_CHANGED_PATHS } from "./deploy-paths.ts";

let repo: string;
let first: string;
let second: string;
let third: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "ccqa-deploy-paths-"));
  const git = (...args: string[]) =>
    execFileP("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
  await git("init", "-q", "-b", "main");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "first");
  first = (await git("rev-parse", "HEAD")).stdout.trim();

  await writeFile(join(repo, "feature.ts"), "export const a = 1;\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "second");
  second = (await git("rev-parse", "HEAD")).stdout.trim();

  await git("mv", "feature.ts", "renamed.ts");
  await git("commit", "-q", "-m", "third");
  third = (await git("rev-parse", "HEAD")).stdout.trim();
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("changedPathsBetween", () => {
  test("reports a rollback, which a three-dot diff would hide", async () => {
    // Redeploying an ancestor: `second` is what the environment had, `first` is
    // what is being shipped. Three-dot resolves the merge base (= `first`) and
    // reports nothing, so the rollback would look like a deploy that changed
    // no files — the failure this function exists to avoid.
    const threeDot = await execFileP("git", ["diff", "--name-only", `${second}...${first}`], { cwd: repo });
    expect(threeDot.stdout.trim()).toBe("");

    expect(await changedPathsBetween(second, first, repo)).toEqual(["feature.ts"]);
  });

  test("a rename reports both the old and the new path", async () => {
    // Rename detection would report only `renamed.ts`, silently dropping
    // `feature.ts` from what the deploy reports as changed.
    expect((await changedPathsBetween(second, third, repo)).sort()).toEqual(["feature.ts", "renamed.ts"]);
  });

  test("a forward deploy lists what it added", async () => {
    expect(await changedPathsBetween(first, second, repo)).toEqual(["feature.ts"]);
  });
});

describe("capDeployPaths", () => {
  test("caps a deploy's request body well above the hub's own retention bound", () => {
    expect(MAX_SENT_CHANGED_PATHS).toBeGreaterThan(MAX_RETAINED_CHANGED_PATHS);
    const paths = Array.from({ length: MAX_SENT_CHANGED_PATHS + 10 }, (_, i) => `src/f${i}.ts`);
    expect(capDeployPaths(paths)).toHaveLength(MAX_SENT_CHANGED_PATHS);
  });
});
