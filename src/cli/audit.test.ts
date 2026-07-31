import { describe, expect, test, vi } from "vitest";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";
import type { Run } from "../hub/contract/schema.ts";
import type { SpecResult } from "../drift/types.ts";
import * as log from "./logger.ts";
import {
  pushDriftResults,
  requireReportToHubConnection,
  resolveAuditHubContext,
  resolveAuditPromptContext,
} from "./audit.ts";

function fakeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    project: "demo",
    profile: null,
    branch: null,
    status: "passed",
    kind: "drift",
    drift: null,
    specs: { total: 1, passed: 1, failed: 0 },
    gitHead: null,
    promptVersion: "1",
    ciRunId: null,
    reportCreatedAt: "2024-01-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeHubClient(pushRun: HubClient["pushRun"]): HubClient {
  return { pushRun } as unknown as HubClient;
}

const results: SpecResult[] = [{ target: { featureName: "tasks", specName: "create" }, ok: true, drift: null }];

describe("pushDriftResults", () => {
  test("exits rather than skipping when no hub is configured", async () => {
    // Asking to publish and silently not publishing is the failure mode this
    // guards: a CI job would go green having recorded nothing.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(
      pushDriftResults(
        { results, threshold: "error", cwd: process.cwd(), opts: { project: "demo" }, format: "text" },
        () => null,
      ),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(2);
    exit.mockRestore();
  });

  test("pushes the report with kind: drift when a hub is configured", async () => {
    const pushRun = vi.fn().mockResolvedValue(fakeRun());
    const hub = fakeHubClient(pushRun);

    await pushDriftResults(
      { results, threshold: "error", cwd: process.cwd(), opts: { project: "demo" }, format: "text" },
      () => hub,
    );

    expect(pushRun).toHaveBeenCalledTimes(1);
    const [, meta] = pushRun.mock.calls[0]!;
    expect(meta).toMatchObject({ project: "demo", kind: "drift" });
  });

  test("exits 2 when the hub push fails with a HubApiError", async () => {
    const pushRun = vi.fn().mockRejectedValue(new HubApiError(503, "no_encryption_key", "encryption not configured"));
    const hub = fakeHubClient(pushRun);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      pushDriftResults(
        { results, threshold: "error", cwd: process.cwd(), opts: { project: "demo" }, format: "text" },
        () => hub,
      ),
    ).rejects.toThrow("process.exit(2)");

    expect(exitSpy).toHaveBeenCalledWith(2);
    vi.restoreAllMocks();
  });
});

describe("requireReportToHubConnection", () => {
  test("does nothing when --report-to-hub was not requested", () => {
    expect(() => requireReportToHubConnection({})).not.toThrow();
  });

  test("does nothing when a hub connection is available", () => {
    expect(() =>
      requireReportToHubConnection({ reportToHub: true, hubUrl: "http://hub.example", hubToken: "t" }),
    ).not.toThrow();
  });

  test("exits before the sweep would run when --report-to-hub has no hub connection", () => {
    // Stubbed so a CCQA_HUB_URL/CCQA_HUB_TOKEN left in the environment can't
    // make this test flaky: it must fail on missing opts, not on env leakage.
    vi.stubEnv("CCQA_HUB_URL", "");
    vi.stubEnv("CCQA_HUB_TOKEN", "");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => requireReportToHubConnection({ reportToHub: true })).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(2);
    exit.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe("resolveAuditHubContext", () => {
  test("no hub configured resolves to null without warning", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(resolveAuditHubContext({}, process.cwd())).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("a hub configured with an unresolvable --project warns and degrades to null", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ctx = resolveAuditHubContext(
      { hubUrl: "http://hub.example", hubToken: "t", project: ".bad" },
      process.cwd(),
    );
    expect(ctx).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("project name could not be resolved"));
    warnSpy.mockRestore();
  });

  test("a malformed --hub-header propagates instead of silently degrading to no guidance", () => {
    expect(() =>
      resolveAuditHubContext(
        { hubUrl: "http://hub.example", hubToken: "t", hubHeader: ["no-colon-here"] },
        process.cwd(),
      ),
    ).toThrow(/invalid --hub-header/);
  });
});

function fakeHubContext(getPrompt: HubClient["getPrompt"]): HubContext {
  return { hub: { getPrompt } as unknown as HubClient, project: "demo" };
}

describe("resolveAuditPromptContext", () => {
  test("no hub configured resolves to empty guidance and no provenance", async () => {
    const ctx = await resolveAuditPromptContext({}, process.cwd(), () => null);
    expect(ctx.guidance).toEqual({ userPromptBlock: "", customPromptBlock: "" });
    expect(ctx.customPromptVersion).toBeNull();
    expect(ctx.triageUserPromptHash).toBeNull();
  });

  test("fetches audit.user and audit.agent by name and renders them into the guidance blocks", async () => {
    const getPrompt = vi.fn(async (_project: string, name: string) => {
      if (name === "audit.user") return "Always re-check block includes first.";
      if (name === "audit.agent") {
        return JSON.stringify({
          schemaVersion: 1,
          basePromptVersion: "5",
          customPromptVersion: "2026-07-01-c2",
          generatedAt: "2026-07-01T00:00:00.000Z",
          guidance: "Prefer SPEC_CHANGE when a whole page is gone.",
        });
      }
      return null;
    });
    const ctx = await resolveAuditPromptContext({}, process.cwd(), () => fakeHubContext(getPrompt));

    expect(getPrompt).toHaveBeenCalledWith("demo", "audit.user");
    expect(getPrompt).toHaveBeenCalledWith("demo", "audit.agent");
    expect(ctx.guidance.userPromptBlock).toContain("Always re-check block includes first.");
    expect(ctx.guidance.customPromptBlock).toContain("Prefer SPEC_CHANGE when a whole page is gone.");
    expect(ctx.customPromptVersion).toBe("2026-07-01-c2");
    expect(ctx.triageUserPromptHash).not.toBeNull();
  });

  test("a hub that cannot be reached throws rather than degrading to no guidance", async () => {
    const getPrompt = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      resolveAuditPromptContext({}, process.cwd(), () => fakeHubContext(getPrompt)),
    ).rejects.toThrow(/could not read from the hub/);
  });
});
