import { describe, expect, test, vi } from "vitest";
import { createHubClient, HubApiError } from "./index.ts";

/** Minimal fetch-compatible Response stand-in for mocking `fetchImpl`. */
function fakeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
  } as Response;
}

describe("createHubClient retry behavior", () => {
  test("GET retries after a 503 and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503))
      .mockResolvedValueOnce(fakeResponse(200, { id: "run-1" }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    const run = await hub.getRun("run-1");

    expect(run).toEqual({ id: "run-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("GET throws HubApiError after exhausting retries on repeated 503s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503, { error: { code: "server_error" } }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    await expect(hub.getRun("run-1")).rejects.toThrow(HubApiError);
    // 1 initial attempt + retries; must not retry forever.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test("POST does not retry on 503 — fails on the first attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503, { error: { code: "server_error" } }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    await expect(hub.pushRun(new Uint8Array(), { project: "demo" })).rejects.toThrow(HubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("GET does not retry on a 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(404, { error: { code: "not_found" } }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    await expect(hub.getRun("run-1")).rejects.toThrow(HubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // getPrompt is the one read that turns 404 into null (an unset prompt is a
  // normal state, not an error) — unlike getRun/getSession which throw.
  test("getPrompt returns null on a 404 instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(404, { error: { code: "not_found" } }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    await expect(hub.getPrompt("demo", "analysis-custom-prompt")).resolves.toBeNull();
  });
});
