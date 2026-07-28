import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { executeRun } from "./pipeline.ts";
import { RunUsageError } from "./errors.ts";

/**
 * The `--only-stale` guards, at the entry point that owns them. All of these
 * must fail *before* any spec executes — the failure mode this feature has to
 * avoid is an unanswerable question quietly selecting nothing.
 */

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-pipeline-"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("executeRun selection guards", () => {
  test("a selection filter cannot be combined with an explicit spec target", async () => {
    await expect(executeRun(["f/s"], { onlyHubStale: true, cwd })).rejects.toThrow(
      /cannot be combined/,
    );
  });

  test("--only-hub-stale without --hub-profile names the flag it needs", async () => {
    const err = await executeRun([], { onlyHubStale: true, cwd }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunUsageError);
    expect((err as Error).message).toMatch(/--hub-profile/);
  });

  test("--only-hub-stale without hub credentials fails on the profile the flag requires", async () => {
    vi.stubEnv("CCQA_HUB_URL", "");
    vi.stubEnv("CCQA_HUB_TOKEN", "");
    await expect(executeRun([], { onlyHubStale: true, hubProfile: "stg", cwd })).rejects.toThrow(
      /hub URL and token are required/,
    );
  });

  test("--only-hub-stale --dry-run without hub credentials names the flag that needs one", async () => {
    // A dry run resolves no profile environment, so this is the path on which
    // the missing hub surfaces as last-run's own requirement.
    vi.stubEnv("CCQA_HUB_URL", "");
    vi.stubEnv("CCQA_HUB_TOKEN", "");
    await expect(
      executeRun([], { onlyHubStale: true, hubProfile: "stg", dryRun: true, cwd }),
    ).rejects.toThrow(/--only-hub-stale requires a hub connection/);
  });
});
