import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";

vi.mock("./preflight.ts", () => ({ preflightAgentBrowserCommand: vi.fn(async () => undefined) }));
vi.mock("../drift/analyze.ts", () => ({ analyzeDrift: vi.fn() }));
vi.mock("../report/analyze.ts", () => ({ analyzeFailure: vi.fn() }));
vi.mock("../report/live-transcript-excerpt.ts", () => ({
  buildLiveTranscriptExcerpt: vi.fn(async () => null),
}));
vi.mock("../store/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.ts")>();
  return {
    ...actual,
    loadPromptBundleFromHub: vi.fn(async () => null),
    loadAllBlocks: vi.fn(async () => new Map()),
    loadAvailableBlocks: vi.fn(async () => []),
    readSpecFile: vi.fn(async () => SAMPLE_SPEC_YAML),
  };
});
vi.mock("../runtime/live-executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/live-executor.ts")>();
  return { ...actual, runLiveExecutor: vi.fn() };
});
vi.mock("../prompts/live.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prompts/live.ts")>();
  return { ...actual, generateLiveSessionName: vi.fn(() => "test-session") };
});
vi.mock("../diagnose/snapshot.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../diagnose/snapshot.ts")>();
  return { ...actual, closeSession: vi.fn(async () => undefined) };
});

const SAMPLE_SPEC_YAML = `title: sample spec\nsteps:\n  - instruction: click Submit\n    expected: form is submitted\n`;

const { analyzeDrift } = await import("../drift/analyze.ts");
const { runLiveExecutor } = await import("../runtime/live-executor.ts");
const { resolveSessionState, runLiveSpecs } = await import("./run-live.ts");

const VALID_STATE = { cookies: [], origins: [] };

/** Minimal HubClient stub: only `getSession` is exercised by resolveSessionState. */
function fakeHub(
  handler: (project: string, profile: string, name: string) => Promise<unknown>,
): HubClient {
  return { getSession: handler } as unknown as HubClient;
}

function hubCtx(handler: (project: string, profile: string, name: string) => Promise<unknown>): HubContext {
  return { hub: fakeHub(handler), project: "test-project" };
}

describe("resolveSessionState", () => {
  test("fails without a hub connection when sessions are requested", async () => {
    const r = await resolveSessionState(["admin"], null, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("admin");
      expect(r.hint).toMatch(/CCQA_HUB_URL|CCQA_HUB_TOKEN|--hub-url|--hub-token/);
    }
  });

  test("restores a single session from the hub into a temp file, removed by cleanup", async () => {
    const ctx = hubCtx(async () => VALID_STATE);
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statePath.startsWith(tmpdir())).toBe(true);
    expect(r.statePath).not.toContain(".ccqa/sessions");
    await r.cleanup();
    await expect(stat(r.statePath)).rejects.toThrow();
  });

  test("merges multiple hub sessions into a temp file", async () => {
    const ctx = hubCtx(async (_project, _profile, name) =>
      name === "admin"
        ? { cookies: [{ name: "a", domain: "x.example", path: "/" }], origins: [] }
        : { cookies: [{ name: "b", domain: "y.example", path: "/" }], origins: [] },
    );
    const r = await resolveSessionState(["admin", "viewer"], ctx, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statePath.startsWith(tmpdir())).toBe(true);
    await r.cleanup();
  });

  test("fails with a bootstrap hint when the hub has no such session", async () => {
    const ctx = hubCtx(async () => {
      throw new Error("not found");
    });
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("fails when the hub returns a value that isn't storage-state shaped", async () => {
    const ctx = hubCtx(async () => ({ nope: true }));
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("threads --profile into the bootstrap hint", async () => {
    const ctx = hubCtx(async () => {
      throw new Error("not found");
    });
    const r = await resolveSessionState(["admin"], ctx, "stg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin --profile stg");
  });
});

function emptyCost() {
  return {
    totalCostUsd: null,
    durationApiMs: null,
    numTurns: null,
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    models: [],
  };
}

function fakeLiveRunResult(status: "passed" | "failed") {
  return {
    runId: "run-1",
    status,
    sessionName: "test-session",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    steps: [],
    cost: emptyCost(),
  };
}

describe("runLiveSpecs drift audit gating", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "ccqa-run-live-test-"));
    vi.mocked(analyzeDrift).mockClear();
    vi.mocked(analyzeDrift).mockResolvedValue([
      { target: { featureName: "x", specName: "y" }, ok: true, issues: [] },
    ]);
    vi.mocked(runLiveExecutor)
      .mockReset()
      .mockResolvedValueOnce(fakeLiveRunResult("passed"))
      .mockResolvedValueOnce(fakeLiveRunResult("failed"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  test("analyzeDrift runs only for the failed spec, not the passing one", async () => {
    const specA = { featureName: "feature-a", specName: "spec-pass" };
    const specB = { featureName: "feature-b", specName: "spec-fail" };

    await runLiveSpecs([specA, specB], { out: outDir });

    expect(analyzeDrift).toHaveBeenCalledTimes(1);
    expect(analyzeDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ featureName: specB.featureName, specName: specB.specName }],
      }),
    );
  });
});
