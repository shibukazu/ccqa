import type { RouteContext } from "../router.ts";
import { sendJson } from "../respond.ts";

/** GET /api/v1/health — unauthenticated liveness probe. `queueDepth` is the number of learning jobs waiting. */
export function createHealthHandler(queueDepth: () => number) {
  return async (ctx: RouteContext): Promise<void> => {
    sendJson(ctx.res, 200, { status: "ok", version: 1, queueDepth: queueDepth() });
  };
}
