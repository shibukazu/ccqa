import { describe, expect, test, vi } from "vitest";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import { RunUsageError } from "../run/errors.ts";
import { openHubRun, requireReportToHubConnection } from "./open-hub-run.ts";

function fakeConn(openRun: HubClient["openRun"]): { hub: HubClient; project: string } {
  return { hub: { openRun } as unknown as HubClient, project: "demo" };
}

describe("openHubRun", () => {
  test("a failed open is raised, not degraded to a local-only command", async () => {
    // Raised rather than exited so the caller's `finally` still runs — the
    // audit releases its spec claims there.
    const openRun = vi.fn().mockRejectedValue(new HubApiError(503, "unavailable", "hub down"));
    await expect(openHubRun("drift", fakeConn(openRun), process.cwd())).rejects.toThrow(RunUsageError);
  });

  test("names the opened run on stderr, so a caller can link to it mid-command", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await openHubRun("drift", fakeConn(vi.fn().mockResolvedValue({ id: "run-7" })), process.cwd());
      expect(write).toHaveBeenCalledWith('[hub-run] {"id":"run-7","kind":"drift"}\n');
    } finally {
      write.mockRestore();
    }
  });
});

describe("requireReportToHubConnection", () => {
  test("returns the connection when one is available", () => {
    const conn = fakeConn(vi.fn());
    expect(requireReportToHubConnection(conn)).toBe(conn);
  });

  test("exits before the command would spend anything when there is no hub", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    expect(() => requireReportToHubConnection(null)).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(2);
    exit.mockRestore();
  });
});
