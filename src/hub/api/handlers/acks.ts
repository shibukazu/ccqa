import { PutAckRequestSchema, type AckResponse } from "../../contract/schema.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { readJsonBody, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/**
 * Pre-parse guard only. `PutAckRequestSchema` holds the real bound (5000 keys
 * of 256 characters); this sits above the largest body that can satisfy it —
 * 5000 keys of 256 `\uXXXX`-escaped characters — so a conforming client is
 * never answered 413 by a limit the documented bounds don't mention.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function requireAckKey(ctx: RouteContext): { project: string; profile: string; name: string } {
  return {
    project: requireSafeSegment(ctx.params.project!, "project"),
    profile: requireProfileParam(ctx.url),
    name: requireSafeSegment(ctx.params.name!, "name"),
  };
}

/**
 * GET /api/v1/projects/:project/acks/:name?profile= — an unset ack answers 200
 * with an empty set, not 404: "nothing acted on yet" is a real answer, and a
 * 404 there is a special case consumers get wrong.
 */
export function createGetAckHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireAckKey(ctx);
    const ack = await storage.acks.get(key.project, key.profile, key.name);
    sendJson(ctx.res, 200, { ...key, ...ack } satisfies AckResponse);
  };
}

/** PUT /api/v1/projects/:project/acks/:name?profile= */
export function createPutAckHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireAckKey(ctx);
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, PutAckRequestSchema, "ack body");
    const ack = await storage.acks.put(key.project, key.profile, key.name, body.keys);
    sendJson(ctx.res, 200, { ...key, ...ack } satisfies AckResponse);
  };
}
