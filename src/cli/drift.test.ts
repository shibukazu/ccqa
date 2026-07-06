import { describe, expect, test, vi } from "vitest";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import type { Run } from "../hub/contract/schema.ts";
import type { SpecResult } from "../drift/types.ts";
import { pushDriftResults } from "./drift.ts";

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

const results: SpecResult[] = [{ target: { featureName: "tasks", specName: "create" }, ok: true, issues: [] }];

describe("pushDriftResults", () => {
  test("warns and returns without throwing when no hub is configured", async () => {
    await expect(
      pushDriftResults(
        { results, threshold: "error", cwd: process.cwd(), opts: { project: "demo" }, format: "text" },
        () => null,
      ),
    ).resolves.toBeUndefined();
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
