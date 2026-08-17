import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileHubStorage } from "../../core/storage/file/index.ts";
import { coverageEventsPath } from "../../core/storage/file/paths.ts";
import { createHubServer, type HubServerConfig } from "../server.ts";

const TOKEN = "hub-token";
const APP_TOKEN = "app-token";
const KEY = Buffer.alloc(32, 7);

/** A minimal valid application push (`PushSchema`) — recognised by `protocol`. */
const PUSH = {
  protocol: 1,
  pid: 42,
  startedAt: 1000,
  unattributed: 0,
  specs: { "demo/example": ["src/a.ts"] },
  boot: ["src/boot.ts"],
};

/** A minimal valid run event (`RunEventSchema`) — recognised by `kind`. */
const RUN_EVENT = { kind: "spec-open", runId: "run-1", specId: "demo/example" };

describe("coverage inbox API", () => {
  let dataDir: string;
  let servers: Server[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-coverage-"));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Start a hub with the inbox fully configured unless a test overrides a piece of it. */
  async function startHub(overrides: Partial<HubServerConfig> = {}): Promise<string> {
    const server = createHubServer({
      storage: createFileHubStorage(dataDir),
      token: TOKEN,
      encryptionKey: KEY,
      allowedOrigins: [],
      coverageToken: APP_TOKEN,
      ...overrides,
    });
    servers.push(server);
    // IPv4 loopback explicitly, for the same port-family exclusivity reason as server.test.ts.
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  function post(baseUrl: string, token: string | null, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/coverage/events?project=demo`, {
      method: "POST",
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function get(baseUrl: string, token: string | null, query = ""): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/coverage/events?project=demo${query}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  }

  test("the app token appends a push; the bearer token reads it back stamped", async () => {
    const baseUrl = await startHub();
    expect((await post(baseUrl, APP_TOKEN, PUSH)).status).toBe(204);

    const res = await get(baseUrl, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number; at: number; body: unknown }[]; lastSeq: number; skipped: number };
    expect(body.lastSeq).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.seq).toBe(1);
    expect(typeof body.events[0]!.at).toBe("number");
    expect(body.events[0]!.body).toMatchObject(PUSH);
  });

  test("events land on disk encrypted, not in the clear", async () => {
    const baseUrl = await startHub();
    await post(baseUrl, APP_TOKEN, PUSH);
    const stored = await readFile(coverageEventsPath(dataDir, "demo"), "utf8");
    expect(stored).not.toContain("src/a.ts");
    expect(stored).toContain('"seq":1');
  });

  test("the app token cannot append a run event", async () => {
    const baseUrl = await startHub();
    const res = await post(baseUrl, APP_TOKEN, RUN_EVENT);
    expect(res.status).toBe(403);
  });

  test("the bearer token appends run events", async () => {
    const baseUrl = await startHub();
    expect((await post(baseUrl, TOKEN, RUN_EVENT)).status).toBe(204);
  });

  test("a wrong or missing token is 401", async () => {
    const baseUrl = await startHub();
    expect((await post(baseUrl, "not-a-token", PUSH)).status).toBe(401);
    expect((await post(baseUrl, null, PUSH)).status).toBe(401);
  });

  test("with no coverage token configured, app pushes get 503 but the bearer token still appends", async () => {
    const baseUrl = await startHub({ coverageToken: undefined });
    expect((await post(baseUrl, APP_TOKEN, PUSH)).status).toBe(503);
    expect((await post(baseUrl, TOKEN, PUSH)).status).toBe(204);
  });

  test("with no encryption key, the whole inbox is 503", async () => {
    const baseUrl = await startHub({ encryptionKey: null });
    expect((await post(baseUrl, TOKEN, PUSH)).status).toBe(503);
    expect((await get(baseUrl, TOKEN)).status).toBe(503);
  });

  test("GET filters by sinceSeq (exclusive) and reports lastSeq", async () => {
    const baseUrl = await startHub();
    await post(baseUrl, APP_TOKEN, PUSH);
    await post(baseUrl, TOKEN, RUN_EVENT);
    await post(baseUrl, APP_TOKEN, PUSH);

    const res = await get(baseUrl, TOKEN, "&sinceSeq=1");
    const body = (await res.json()) as { events: { seq: number }[]; lastSeq: number };
    expect(body.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(body.lastSeq).toBe(3);
  });

  test("GET requires the hub bearer token — the app token cannot read back", async () => {
    const baseUrl = await startHub();
    expect((await get(baseUrl, APP_TOKEN)).status).toBe(401);
  });

  test("a body that is neither a push nor a run event is 400", async () => {
    const baseUrl = await startHub();
    expect((await post(baseUrl, TOKEN, { nope: true })).status).toBe(400);
  });
});
