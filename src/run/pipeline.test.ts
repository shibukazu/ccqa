import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { executeRun, holdSpecs } from "./pipeline.ts";
import { RunUsageError } from "./errors.ts";
import type { SpecCatalog } from "./spec-catalog.ts";
import type { HubContext } from "../cli/hub-conn.ts";

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
    await expect(executeRun(["f/s"], { onlyHubRerunNeeded: true, cwd })).rejects.toThrow(
      /cannot be combined/,
    );
  });

  test("--only-hub-rerun-needed without --hub-profile names the flag it needs", async () => {
    const err = await executeRun([], { onlyHubRerunNeeded: true, cwd }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunUsageError);
    expect((err as Error).message).toMatch(/--hub-profile/);
  });

  test("--only-hub-rerun-needed without hub credentials fails on the profile the flag requires", async () => {
    vi.stubEnv("CCQA_HUB_URL", "");
    vi.stubEnv("CCQA_HUB_TOKEN", "");
    await expect(executeRun([], { onlyHubRerunNeeded: true, hubProfile: "stg", cwd })).rejects.toThrow(
      /hub URL and token are required/,
    );
  });

  test("--only-hub-rerun-needed --dry-run without hub credentials names the flag that needs one", async () => {
    // A dry run resolves no profile environment, so this is the path on which
    // the missing hub surfaces as last-run's own requirement.
    vi.stubEnv("CCQA_HUB_URL", "");
    vi.stubEnv("CCQA_HUB_TOKEN", "");
    await expect(
      executeRun([], { onlyHubRerunNeeded: true, hubProfile: "stg", dryRun: true, cwd }),
    ).rejects.toThrow(/--only-hub-rerun-needed requires a hub connection/);
  });
});

describe("claiming specs and the resources they share", () => {
  const specs = [
    { featureName: "f", specName: "post-a" },
    { featureName: "f", specName: "post-b" },
    { featureName: "f", specName: "read" },
  ];
  const catalog = new Map([
    ["f/post-a", { spec: { exclusive: ["channel"] }, error: null }],
    ["f/post-b", { spec: { exclusive: ["channel"] }, error: null }],
    ["f/read", { spec: {}, error: null }],
  ]) as unknown as SpecCatalog;

  /** Grants every key asked for except those named, recording each request. */
  function hubDenying(denied: string[], asked: string[][] = []) {
    return {
      asked,
      ctx: {
        project: "demo",
        hub: {
          acquireLocks: async (_p: string, _q: unknown, body: { specs: string[] }) => {
            asked.push(body.specs);
            return {
              granted: body.specs.filter((k) => !denied.includes(k)),
              denied: body.specs.filter((k) => denied.includes(k)),
            };
          },
          releaseLocks: async () => {},
        },
      } as unknown as HubContext,
    };
  }

  test("a resource another job holds drops every spec needing it, and is not claimed for them", async () => {
    const { ctx, asked } = hubDenying(["resource:channel"]);
    const held = await holdSpecs(ctx, "ci", specs, catalog, undefined);
    expect(held).toEqual({ specs: [specs[2]], deniedResources: ["channel"] });
    // Resources first, then only the survivors: holding a spec this run will
    // not execute would read to every other job as covered when it is not.
    expect(asked).toEqual([["resource:channel"], ["f/read"]]);
  });

  test("a hub that cannot serve claims fails the run when a resource was declared", async () => {
    const ctx = {
      project: "demo",
      hub: { acquireLocks: async () => { throw new Error("410 gone"); } },
    } as unknown as HubContext;
    await expect(holdSpecs(ctx, "ci", specs, catalog, undefined)).rejects.toThrow(/exclusive/);

    // With nothing declared there is no wrong verdict to cause, so it degrades.
    const plain = [{ featureName: "f", specName: "read" }];
    const held = await holdSpecs(ctx, "ci", plain, catalog, undefined);
    expect(held).toEqual({ specs: plain, deniedResources: [] });
  });
});
