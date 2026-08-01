import { describe, expect, test, vi } from "vitest";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";
import type { Run } from "../hub/contract/schema.ts";
import type { SpecResult } from "../drift/types.ts";
import * as log from "./logger.ts";
import type { HubRunPush } from "./open-hub-run.ts";
import {
  resolveAuditHubContext,
  resolveAuditPromptContext,
  sealDriftPush,
  sendDriftRow,
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
    costUsd: null,
    ciRunId: null,
    reportCreatedAt: "2024-01-01T00:00:00.000Z",
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakePush(patchRun: HubClient["patchRun"]): HubRunPush {
  return { hub: { patchRun } as unknown as HubClient, kind: "drift", runId: "r1", gitHead: null };
}

const results: SpecResult[] = [{ target: { featureName: "tasks", specName: "create" }, ok: true, drift: null }];

describe("incremental drift push", () => {
  test("a failed row patch does not abort the sweep", async () => {
    // Thrown here it would kill the pool mid-sweep and lose the specs still
    // running — worse than the missing row, which the seal resends anyway.
    const patchRun = vi.fn().mockRejectedValue(new HubApiError(500, "boom", "nope"));
    await expect(
      sendDriftRow(fakePush(patchRun), results[0]!, "error"),
    ).resolves.toBeUndefined();
  });

  test("the seal sends every row and closes the run", async () => {
    // Every row, not just the unsent ones: that is what repairs a row whose
    // mid-sweep patch failed.
    const patchRun = vi.fn().mockResolvedValue(fakeRun());
    await sealDriftPush(
      fakePush(patchRun),
      { results, threshold: "error", opts: { project: "demo" }, format: "json" },
    );

    expect(patchRun).toHaveBeenCalledTimes(1);
    const [id, body] = patchRun.mock.calls[0]!;
    expect(id).toBe("r1");
    expect(body.done).toBe(true);
    expect(body.rows).toHaveLength(results.length);
    expect(body.rows[0]).toMatchObject({ feature: "tasks", spec: "create" });
  });

  test("exits 2 when the seal fails, leaving a run that is wrong rather than absent", async () => {
    const patchRun = vi.fn().mockRejectedValue(new HubApiError(500, "boom", "nope"));
    vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      sealDriftPush(
        fakePush(patchRun),
        { results, threshold: "error", opts: { project: "demo" }, format: "json" },
      ),
    ).rejects.toThrow("process.exit(2)");
    vi.restoreAllMocks();
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
