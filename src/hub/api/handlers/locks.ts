import {
  AcquireLocksRequestSchema,
  ReleaseLocksRequestSchema,
  type AcquireLocksResponse,
} from "../../contract/schema.ts";
import { acquire, releaseAll } from "../../core/locks.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { readJsonBody, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/** A spec-key list and three short strings; nothing here should approach this. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * POST /api/v1/projects/:project/locks?profile=
 *
 * Take the specs that are free. Denials are part of the answer, not an error:
 * another job got there first, and skipping those is the point.
 *
 * The whole read-modify-write happens inside the store's critical section, so
 * two jobs asking at the same moment cannot both read "free".
 */
export function createAcquireLocksHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, AcquireLocksRequestSchema, "lock request");

    let result: AcquireLocksResponse = { granted: [], denied: [] };
    await storage.locks.update(project, profile, (current) => {
      const next = acquire(current, { ...body, now: new Date() });
      result = { granted: next.granted, denied: next.denied };
      return next.locks;
    });
    sendJson(ctx.res, 200, result);
  };
}

/**
 * DELETE /api/v1/projects/:project/locks?profile=
 *
 * Drop everything this run holds. Keyed by run, so a late release from a run
 * whose hold already lapsed cannot take a lock the next job has acquired.
 */
export function createReleaseLocksHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, ReleaseLocksRequestSchema, "release request");
    await storage.locks.update(project, profile, (current) => releaseAll(current, body.holder));
    ctx.res.writeHead(204).end();
  };
}
