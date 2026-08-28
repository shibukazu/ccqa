import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedCoverage } from "../../../coverage/resolve-stream.ts";
import { createFileHubStorage } from "../../core/storage/file/index.ts";
import { coverageEventsPath } from "../../core/storage/file/paths.ts";
import { createResolveMemo } from "./coverage.ts";
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

  // == GET /api/v1/coverage — the read-time resolve (ADR-0022) ==========

  function getResolved(baseUrl: string, token: string | null, query = ""): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/coverage?project=demo${query}`, {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    });
  }

  test("resolves the stream for a run: markers gate the push, both halves land", async () => {
    const baseUrl = await startHub();
    await post(baseUrl, TOKEN, RUN_EVENT); // spec-open run-1 demo/example
    await post(baseUrl, APP_TOKEN, PUSH); // arrives inside run-1's marker span
    await post(baseUrl, TOKEN, { kind: "browser", runId: "run-1", specId: "demo/example", files: ["src/web.ts"] });
    await post(baseUrl, TOKEN, { kind: "spec-close", runId: "run-1", specId: "demo/example" });

    const res = await getResolved(baseUrl, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: ResolvedCoverage | null; runIds: string[] };
    expect(body.runIds).toEqual(["run-1"]);
    expect(body.resolved?.runId).toBe("run-1");
    expect(body.resolved?.lastSeq).toBe(4);
    expect(body.resolved?.specs).toEqual([
      { specId: "demo/example", files: ["src/a.ts", "src/web.ts"], actorEvents: {} },
    ]);
    expect(body.resolved?.boot).toEqual(["src/boot.ts"]);
    expect(body.resolved?.health.heardFromApplication).toBe(true);
  });

  test("runId omitted picks the run that last opened a spec; naming one serves history", async () => {
    const baseUrl = await startHub();
    await post(baseUrl, TOKEN, RUN_EVENT);
    await post(baseUrl, TOKEN, { kind: "spec-open", runId: "run-2", specId: "demo/other" });

    const latest = (await (await getResolved(baseUrl, TOKEN)).json()) as { resolved: ResolvedCoverage | null; runIds: string[] };
    expect(latest.runIds).toEqual(["run-2", "run-1"]);
    expect(latest.resolved?.runId).toBe("run-2");

    const named = (await (await getResolved(baseUrl, TOKEN, "&runId=run-1")).json()) as { resolved: ResolvedCoverage | null };
    expect(named.resolved?.runId).toBe("run-1");
    expect(named.resolved?.specs[0]?.specId).toBe("demo/example");
  });

  test("an empty stream resolves to null, and the app token cannot read the resolve", async () => {
    const baseUrl = await startHub();
    expect(await (await getResolved(baseUrl, TOKEN)).json()).toEqual({ resolved: null, runIds: [] });
    expect((await getResolved(baseUrl, APP_TOKEN)).status).toBe(401);
  });

  test("a poll at an unmoved stream position answers from the memo without reading the store", async () => {
    const storage = createFileHubStorage(dataDir);
    const read = vi.spyOn(storage.coverageEvents, "scan");
    const baseUrl = await startHub({ storage });
    await post(baseUrl, TOKEN, RUN_EVENT);

    const first = (await (await getResolved(baseUrl, TOKEN)).json()) as { resolved: ResolvedCoverage | null };
    const readsAfterFirst = read.mock.calls.length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = (await (await getResolved(baseUrl, TOKEN)).json()) as { resolved: ResolvedCoverage | null };
    expect(read.mock.calls.length).toBe(readsAfterFirst);
    expect(second).toEqual(first);

    // A new event moves the stream, so the next poll pays for the read again.
    await post(baseUrl, TOKEN, { kind: "spec-close", runId: "run-1", specId: "demo/example" });
    await getResolved(baseUrl, TOKEN);
    expect(read.mock.calls.length).toBeGreaterThan(readsAfterFirst);
  });
});

describe("createResolveMemo", () => {
  const answer = (id: string): { resolved: null; runIds: string[] } => ({ resolved: null, runIds: [id] });

  test("serves a stored answer only for exactly its stream position", () => {
    const memo = createResolveMemo(8);
    const stored = answer("run-1");
    memo.put("p", "run-1", 3, stored);
    expect(memo.get("p", "run-1", 3)).toBe(stored);
    expect(memo.get("p", "run-1", 4)).toBeUndefined(); // a new event moved the stream
    expect(memo.get("p", "run-2", 3)).toBeUndefined(); // another run over the same stream
    expect(memo.get("p", "", 3)).toBeUndefined(); // the latest-run view is its own key
  });

  test("evicts the least recently used answer past the limit", () => {
    const memo = createResolveMemo(2);
    memo.put("p", "a", 1, answer("a"));
    memo.put("p", "b", 1, answer("b"));
    memo.get("p", "a", 1); // refreshes "a", so "b" is now the oldest
    memo.put("p", "c", 1, answer("c")); // evicts "b"
    expect(memo.get("p", "a", 1)).toBeDefined();
    expect(memo.get("p", "b", 1)).toBeUndefined();
    expect(memo.get("p", "c", 1)).toBeDefined();
  });
});
