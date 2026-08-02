import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";
import { SESSION_VERIFY_URL_KEY, type SessionRestoreCheck } from "../runtime/session-state.ts";

vi.mock("./preflight.ts", () => ({ preflightAgentBrowserCommand: vi.fn(async () => undefined) }));
vi.mock("../drift/analyze.ts", () => ({ analyzeDrift: vi.fn() }));
// Pinned: without it these assertions read the machine's own Claude login, so
// they pass on a developer's laptop and fail on CI, which has none.
vi.mock("../drift/auth.ts", () => ({ driftAuthAvailable: vi.fn(() => ({ ok: true })) }));
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
const { analyzeFailure } = await import("../report/analyze.ts");
const { buildLiveTranscriptExcerpt } = await import("../report/live-transcript-excerpt.ts");
const { runLiveExecutor } = await import("../runtime/live-executor.ts");
const { readSpecFile } = await import("../store/index.ts");
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
    if (!r.ok) expect(r.hint).toContain("ccqa hub session capture admin");
  });

  test("fails when the hub returns a value that isn't storage-state shaped", async () => {
    const ctx = hubCtx(async () => ({ nope: true }));
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa hub session capture admin");
  });

  test("threads --profile into the bootstrap hint", async () => {
    const ctx = hubCtx(async () => {
      throw new Error("not found");
    });
    const r = await resolveSessionState(["admin"], ctx, "stg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa hub session capture admin --profile stg");
  });

  test("health-checks a session that carries an embedded verify URL", async () => {
    const url = "https://app.example.com/home";
    const ctx = hubCtx(async () => ({ ...VALID_STATE, [SESSION_VERIFY_URL_KEY]: url }));
    const verify = vi.fn((_statePath: string, _url: string): SessionRestoreCheck => ({ restored: true }));
    const r = await resolveSessionState(["hc-ok"], ctx, undefined, verify);
    expect(r.ok).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    // Called with the temp state path and the embedded URL.
    expect(verify.mock.calls[0]?.[1]).toBe(url);
    // The embedded key is stripped from the merged temp state agent-browser loads.
    if (r.ok) {
      const merged = JSON.parse(await readFile(r.statePath, "utf8"));
      expect(SESSION_VERIFY_URL_KEY in merged).toBe(false);
      await r.cleanup();
    }
  });

  test("fails with a re-bootstrap hint when the health check reports not-restored", async () => {
    const ctx = hubCtx(async () => ({ ...VALID_STATE, [SESSION_VERIFY_URL_KEY]: "https://app.example.com/home" }));
    const verify = vi.fn((): SessionRestoreCheck => ({ restored: false, reason: "landed on /signin" }));
    const r = await resolveSessionState(["hc-bad"], ctx, "dev", verify);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("hc-bad");
      expect(r.error).toContain("landed on /signin");
      expect(r.hint).toContain("ccqa hub session capture hc-bad --profile dev");
    }
  });

  test("skips the health check for an old session with no embedded verify URL", async () => {
    const ctx = hubCtx(async () => VALID_STATE);
    const verify = vi.fn((): SessionRestoreCheck => ({ restored: true }));
    const r = await resolveSessionState(["hc-legacy"], ctx, undefined, verify);
    expect(r.ok).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    if (r.ok) await r.cleanup();
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

describe("runLiveSpecs failure-analysis gating", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "ccqa-run-live-test-"));
    vi.mocked(analyzeDrift).mockClear();
    vi.mocked(buildLiveTranscriptExcerpt).mockResolvedValue("step 1 failed");
    vi.mocked(analyzeFailure).mockReset().mockResolvedValue({
      analysis: {
        label: "PRODUCT_BUG",
        confidence: 0.8,
        subDiagnosis: "NONE",
        headline: "h",
        recommendation: "r",
        evidence: [],
        reasoning: "",
      },
      raw: "",
      sdkError: false,
    });
    vi.mocked(runLiveExecutor)
      .mockReset()
      .mockResolvedValueOnce(fakeLiveRunResult("passed"))
      .mockResolvedValueOnce(fakeLiveRunResult("failed"));
  });

  afterEach(async () => {
    vi.mocked(buildLiveTranscriptExcerpt).mockResolvedValue(null);
    vi.mocked(readSpecFile).mockResolvedValue(SAMPLE_SPEC_YAML);
    delete process.env["CCQA_TEST_APP_URL"];
    await rm(outDir, { recursive: true, force: true });
  });

  test("one classification call for the failed spec only, and no separate drift audit", async () => {
    const specA = { featureName: "feature-a", specName: "spec-pass" };
    const specB = { featureName: "feature-b", specName: "spec-fail" };

    // Analysis is opt-in: it only runs when the pipeline resolved a
    // --on-fail-explain baseline and passed a provider down.
    const diffProvider = {
      forSpec: vi.fn(async () => ({
        ok: true as const,
        base: { ref: "origin/main", sha: "0".repeat(40), source: "explicit" as const },
        patch: null,
        nameStatus: null,
        error: null,
        range: null,
        fileDiff: () => null,
      })),
    };
    await runLiveSpecs([specA, specB], { out: outDir, diffProvider, resources: () => [] });

    expect(analyzeFailure).toHaveBeenCalledTimes(1);
    expect(diffProvider.forSpec).toHaveBeenCalledExactlyOnceWith(specB);
    expect(analyzeDrift).not.toHaveBeenCalled();
    // A `mode: live` spec has no compiled surface at all — declared
    // explicitly rather than inferred from the absent `script` field.
    expect(vi.mocked(analyzeFailure).mock.calls[0]![0].hasGeneratedSurface).toBe(false);
  });

  test("the map built at run start reaches the classifier, so its prose can be scrubbed", async () => {
    process.env["CCQA_TEST_APP_URL"] = "https://app.example.com";
    vi.mocked(readSpecFile).mockResolvedValue(
      "title: sample spec\nsteps:\n  - instruction: open ${CCQA_TEST_APP_URL}\n    expected: loaded\n",
    );
    vi.mocked(runLiveExecutor).mockReset().mockResolvedValue(fakeLiveRunResult("failed"));

    await runLiveSpecs([{ featureName: "feature-a", specName: "spec-fail" }], {
      out: outDir,
      diffProvider: { forSpec: async () => ({ ok: false as const, skip: "no recorded green yet" }) },
      resources: () => [],
    });

    expect(vi.mocked(analyzeFailure).mock.calls[0]![1].envScrubMap).toEqual([
      ["https://app.example.com", "${CCQA_TEST_APP_URL}"],
    ]);
  });

  test("no diffProvider (analysis not requested) makes no Claude call at all", async () => {
    const specA = { featureName: "feature-a", specName: "spec-pass" };
    const specB = { featureName: "feature-b", specName: "spec-fail" };

    await runLiveSpecs([specA, specB], { out: outDir, resources: () => [] });

    expect(analyzeFailure).not.toHaveBeenCalled();
    expect(analyzeDrift).not.toHaveBeenCalled();
  });
});
