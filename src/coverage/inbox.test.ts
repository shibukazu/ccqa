import { describe, expect, test, vi } from "vitest";

import { CoverageInbox } from "./inbox.ts";
import type { RunEvent } from "./events.ts";

/** Minimal fetch-compatible Response stand-in for mocking `fetchImpl`. */
function fakeResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

const EVENT: RunEvent = { kind: "spec-open", runId: "run-1", specId: "run-1.feat/spec" };

function inboxWith(fetchImpl: typeof fetch): CoverageInbox {
  return new CoverageInbox({
    baseUrl: "https://hub.example/",
    token: "t",
    project: "demo",
    headers: { "x-gateway": "bypass" },
    fetchImpl,
  });
}

describe("CoverageInbox", () => {
  test("POSTs the event as JSON to the inbox with the project query and bearer auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(204));

    await inboxWith(fetchImpl).append(EVENT);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://hub.example/api/v1/coverage/events?project=demo");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer t",
      "Content-Type": "application/json",
      "x-gateway": "bypass",
    });
    expect(JSON.parse(init.body as string)).toEqual(EVENT);
  });

  test("retries once after a server error and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(fakeResponse(204));

    await inboxWith(fetchImpl).append(EVENT);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("gives up after the one retry without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503));

    await expect(inboxWith(fetchImpl).append(EVENT)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not retry a 4xx — it answers the same way twice", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(400));

    await expect(inboxWith(fetchImpl).append(EVENT)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
