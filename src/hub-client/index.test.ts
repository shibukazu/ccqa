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

  test("openRun POSTs to /runs/open with the project query and does not retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(201, { id: "run-9", status: "running" }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    const run = await hub.openRun({ project: "demo", branch: "main" });

    expect(run).toEqual({ id: "run-9", status: "running" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/runs/open?");
    expect(String(url)).toContain("project=demo");
    expect((init as RequestInit).method).toBe("POST");
  });

  test("patchRun PATCHes /runs/:id and does not retry on 503", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503, { error: { code: "server_error" } }));
    const hub = createHubClient({ baseUrl: "https://hub.example", token: "t", fetchImpl });

    await expect(hub.patchRun("run-9", { rows: [] })).rejects.toThrow(HubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/runs/run-9");
    expect((init as RequestInit).method).toBe("PATCH");
  });
});

describe("createHubClient custom headers", () => {
  test("sends opts.headers on every request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { id: "run-1" }));
    const hub = createHubClient({
      baseUrl: "https://hub.example",
      token: "t",
      headers: { "x-foo": "bar" },
      fetchImpl,
    });

    await hub.getRun("run-1");

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "x-foo": "bar" });
  });

  test("Authorization always wins, even if opts.headers sets it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { id: "run-1" }));
    const hub = createHubClient({
      baseUrl: "https://hub.example",
      token: "t",
      headers: { Authorization: "Bearer stolen" },
      fetchImpl,
    });

    await hub.getRun("run-1");

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer t" });
  });

  test("per-call headers (e.g. Content-Type) take precedence over opts.headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
    const hub = createHubClient({
      baseUrl: "https://hub.example",
      token: "t",
      headers: { "Content-Type": "text/plain" },
      fetchImpl,
    });

    await hub.putPrompt("demo", "analysis-custom-prompt", "body");

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "text/markdown; charset=utf-8" });
  });
});
