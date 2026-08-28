import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createStoredSourceMaps, executeRun, holdSpecs, noFrontendResolved } from "./pipeline.ts";
import { RunUsageError } from "./errors.ts";
import type { GroupLookup } from "./serial-groups.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import { withSink } from "../cli/logger.ts";

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
  // The group lookup the config resolves to: two posters share one group.
  const inGroup: GroupLookup = (ref) =>
    ref.specName.startsWith("post") ? ["channel"] : [];

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
    const held = await holdSpecs(ctx, "ci", specs, inGroup, undefined);
    expect(held).toEqual({ specs: [specs[2]], deniedResources: ["channel"] });
    // Resources first, then only the survivors: holding a spec this run will
    // not execute would read to every other job as covered when it is not.
    expect(asked).toEqual([["resource:channel"], ["f/read"]]);
  });

  test("a hub that cannot serve claims fails the run when a serial group applies", async () => {
    const ctx = {
      project: "demo",
      hub: { acquireLocks: async () => { throw new Error("410 gone"); } },
    } as unknown as HubContext;
    await expect(holdSpecs(ctx, "ci", specs, inGroup, undefined)).rejects.toThrow(/serialGroups/);

    // With nothing declared there is no wrong verdict to cause, so it degrades.
    const plain = [{ featureName: "f", specName: "read" }];
    const held = await holdSpecs(ctx, "ci", plain, inGroup, undefined);
    expect(held).toEqual({ specs: plain, deniedResources: [] });
  });
});

describe("the ADR-0014 invariant: an empty selection with `inProgress` outstanding exits non-zero", () => {
  let adrCwd: string;

  beforeAll(async () => {
    adrCwd = await mkdtemp(join(tmpdir(), "ccqa-pipeline-adr014-"));
    const specDir = join(adrCwd, ".ccqa", "features", "f", "test-cases", "s");
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, "spec.yaml"),
      "title: f/s\nsteps:\n  - instruction: noop\n    expected: noop\n",
    );
  });

  afterAll(async () => {
    await rm(adrCwd, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs the hub connection and answers `getRerun` with `f/s`'s one entry. */
  function stubRerunReport(specEntry: Record<string, unknown>) {
    vi.stubEnv("CCQA_HUB_URL", "https://hub.invalid");
    vi.stubEnv("CCQA_HUB_TOKEN", "tok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (!String(url).includes("/rerun")) {
          throw new Error(`unexpected fetch in this test: ${String(url)}`);
        }
        return new Response(
          JSON.stringify({
            project: "demo",
            profile: "stg",
            deployHead: { index: 0, sha: "a".repeat(40), at: "2026-01-01T00:00:00.000Z" },
            specs: { "f/s": specEntry },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  }

  test("a lone `inProgress` spec selects nothing, and the run fails rather than reporting green", async () => {
    stubRerunReport({
      verdict: "inProgress", audit: "due", execution: "neverRun",
      heldBy: null, lastRun: null, lastGreen: null, lastRed: null,
    });
    await expect(
      executeRun([], { onlyHubRerunNeeded: true, hubProfile: "stg", dryRun: true, cwd: adrCwd }),
    ).rejects.toThrow(/nothing was selected and no spec was cleared to run/);
  });

  test("names the hole when the excluded spec is stuck on an unplaceable audit baseline, instead of pointing at a re-audit that cannot help", async () => {
    stubRerunReport({
      verdict: "inProgress", audit: "due", execution: "neverRun",
      auditAssumedReached: "deployedShaNotInLog",
      heldBy: null, lastRun: null, lastGreen: null, lastRed: null,
    });
    const lines: string[] = [];
    const err = await withSink({ write: (t) => lines.push(t) }, () =>
      executeRun([], { onlyHubRerunNeeded: true, hubProfile: "stg", dryRun: true, cwd: adrCwd }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunUsageError);
    const output = lines.join("");
    expect(output).toMatch(/deployedShaNotInLog/);
    expect(output).toMatch(/ccqa hub deploy record/);
    expect(output).toMatch(/--only-affected-by/);
    // The old hint re-runs the audit at the same unplaceable commit, which
    // reproduces the same hole rather than closing it — it must not appear
    // once the real cause is known.
    expect(output).not.toMatch(/--only-hub-audit-needed --report-to-hub/);
  });
});

describe("noFrontendResolved", () => {
  const row = (frontendFiles?: number) =>
    (frontendFiles === undefined ? {} : { coverage: { frontendFiles } }) as never;

  test("one row that resolved something is enough to say the browser half worked", () => {
    expect(noFrontendResolved([row(3), row(0)])).toBe(false);
  });

  test("a row carrying no coverage counts as nothing resolved, not as unknown", () => {
    expect(noFrontendResolved([row(), row(0)])).toBe(true);
    expect(noFrontendResolved([])).toBe(true);
  });
});

describe("stored source maps", () => {
  function hubCtx(
    getSourceMap: (project: string, commit: string, asset: string) => Promise<string | null>,
  ): HubContext {
    return { project: "demo", hub: { getSourceMap } } as unknown as HubContext;
  }

  async function capture(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    await withSink({ write: (t) => lines.push(t) }, fn);
    return lines.join("");
  }

  test("names the commit when the store answered for nothing it was asked", async () => {
    const asked: string[] = [];
    const maps = createStoredSourceMaps(
      hubCtx(async (_p, _c, asset) => {
        asked.push(asset);
        return null;
      }),
      "0123456789abcdef0123",
    );
    const output = await capture(async () => {
      expect(await maps.read("a.js.map")).toBeUndefined();
      // The same asset twice is one question — a miss is cached, so the run
      // asks the hub once per asset however many specs walk the same script.
      expect(await maps.read("a.js.map")).toBeUndefined();
      expect(await maps.read("b.js.map")).toBeUndefined();
      maps.warnIfNothingAnswered();
    });
    expect(asked).toEqual(["a.js.map", "b.js.map"]);
    expect(output).toContain("2 script(s)");
    expect(output).toContain("0123456789ab");
  });

  test("stays quiet once anything answered", async () => {
    const maps = createStoredSourceMaps(
      hubCtx(async (_p, _c, asset) => (asset === "a.js.map" ? "{}" : null)),
      "abc",
    );
    const output = await capture(async () => {
      await maps.read("a.js.map");
      await maps.read("b.js.map");
      maps.warnIfNothingAnswered();
    });
    expect(output).toBe("");
  });
});
