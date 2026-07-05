import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFileHubStorage } from "../../core/storage/file/index.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import { HttpError } from "../respond.ts";
import { Router } from "../router.ts";
import { createGetArtifactFileHandler } from "./runs.ts";
import { createGetLearningJobHandler } from "./learning-jobs.ts";
import { createListProfilesHandler } from "./projects.ts";
import { createDeleteSessionHandler, createGetSessionHandler, createPutSessionHandler } from "./secrets.ts";

/**
 * Path-traversal regression coverage for the two handlers that build storage
 * file paths straight from URL params: artifact `*path` and session
 * `:project`/`:profile`/`:name`. Exercised at the router level (not the full
 * HTTP server) so this doesn't collide with concurrent edits to
 * server.test.ts — it still proves the exact thing an attacker controls: a
 * decoded URL pathname reaching `ctx.params` via the same `Router.match` the
 * real server uses.
 */
describe("path traversal guards", () => {
  let dataDir: string;
  let storage: HubStorage;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-traversal-"));
    storage = createFileHubStorage(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function fakeCtx(params: Record<string, string>, pathname: string) {
    const req = { headers: {} } as IncomingMessage;
    const res = { end: () => {}, setHeader: () => {} } as unknown as ServerResponse;
    return { req, res, params, url: new URL(`http://localhost${pathname}`) };
  }

  /** Minimal valid Run for tests that only need a storage record to exist under `runId`. */
  function fakeRun(id: string): Parameters<typeof storage.runs.create>[0] {
    return {
      id,
      project: "demo",
      profile: null,
      branch: null,
      status: "passed",
      specs: { total: 1, passed: 1, failed: 0 },
      gitHead: null,
      promptVersion: "1",
      ciRunId: null,
      reportCreatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
  }

  test("router decodes an encoded '..' segment, confirming handlers see raw traversal input", () => {
    const router = new Router();
    router.get("/api/v1/runs/:id/artifacts/*path", async () => {});
    const matched = router.match("GET", "/api/v1/runs/some-run/artifacts/..%2F..%2Fetc%2Fpasswd");
    expect(matched?.params.path).toBe("../../etc/passwd");
  });

  test("GET artifact file with a traversal path rejects before touching storage", async () => {
    const runId = "some-run-id";
    await storage.runs.create(fakeRun(runId));

    const handler = createGetArtifactFileHandler(storage);
    const ctx = fakeCtx({ id: runId, path: "../../../etc/passwd" }, "/api/v1/runs/some-run-id/artifacts/../../../etc/passwd");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("GET artifact file with a normal relative path still resolves (no artifact stored -> 404, not 400)", async () => {
    const runId = "some-run-id";
    await storage.runs.create(fakeRun(runId));

    const handler = createGetArtifactFileHandler(storage);
    const ctx = fakeCtx({ id: runId, path: "evidence/step1.png" }, "/api/v1/runs/some-run-id/artifacts/evidence/step1.png");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 404 });
  });

  test("PUT session with a traversal profile rejects before touching storage", async () => {
    const handler = createPutSessionHandler({ store: storage.sessions, encryptionKey: Buffer.alloc(32, 1) });
    const ctx = fakeCtx({ project: "demo", profile: "../../evil", name: "admin" }, "/api/v1/projects/demo/sessions/../../evil/admin");
    Object.assign(ctx.req, { on: () => ctx.req, headers: {} });

    let caught: unknown;
    try {
      await handler(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
  });

  test("PUT session with a traversal name rejects before touching storage", async () => {
    const handler = createPutSessionHandler({ store: storage.sessions, encryptionKey: Buffer.alloc(32, 1) });
    const ctx = fakeCtx({ project: "demo", profile: "default", name: "../../evil" }, "/api/v1/projects/demo/sessions/default/../../evil");
    Object.assign(ctx.req, { on: () => ctx.req, headers: {} });

    let caught: unknown;
    try {
      await handler(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
  });

  test("PUT session with a traversal project rejects before touching storage", async () => {
    const handler = createPutSessionHandler({ store: storage.sessions, encryptionKey: Buffer.alloc(32, 1) });
    const ctx = fakeCtx({ project: "../../evil", profile: "default", name: "admin" }, "/api/v1/projects/../../evil/sessions/default/admin");
    Object.assign(ctx.req, { on: () => ctx.req, headers: {} });

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("GET session with a traversal name rejects before touching storage", async () => {
    const handler = createGetSessionHandler({ store: storage.sessions, encryptionKey: Buffer.alloc(32, 1) });
    const ctx = fakeCtx({ project: "demo", profile: "default", name: "../../evil" }, "/api/v1/projects/demo/sessions/default/../../evil");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("DELETE session with a traversal name rejects before touching storage", async () => {
    const handler = createDeleteSessionHandler({ store: storage.sessions, encryptionKey: null });
    const ctx = fakeCtx({ project: "demo", profile: "default", name: "..%2Fevil".replace("%2F", "/") }, "/api/v1/projects/demo/sessions/default/evil");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("DELETE session with a normal profile/name still resolves cleanly (no-op delete)", async () => {
    const handler = createDeleteSessionHandler({ store: storage.sessions, encryptionKey: null });
    const ctx = fakeCtx({ project: "demo", profile: "default", name: "admin" }, "/api/v1/projects/demo/sessions/default/admin");

    await expect(handler(ctx)).resolves.toBeUndefined();
  });

  test("GET learning job with a traversal project rejects before touching storage", async () => {
    const handler = createGetLearningJobHandler(storage);
    const ctx = fakeCtx({ project: "../../evil", jobId: "job-1" }, "/api/v1/projects/../../evil/learning-jobs/job-1");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("GET learning job with a traversal jobId rejects before touching storage", async () => {
    const handler = createGetLearningJobHandler(storage);
    const ctx = fakeCtx({ project: "demo", jobId: "../../evil" }, "/api/v1/projects/demo/learning-jobs/../../evil");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });

  test("GET profiles with a traversal project rejects before touching storage", async () => {
    const handler = createListProfilesHandler(storage);
    const ctx = fakeCtx({ project: "../../evil" }, "/api/v1/projects/../../evil/profiles");

    await expect(handler(ctx)).rejects.toMatchObject({ status: 400 });
  });
});
