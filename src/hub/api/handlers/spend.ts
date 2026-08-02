import { randomUUID } from "node:crypto";
import { RecordSpendRequestSchema, type SpendLogResponse } from "../../contract/schema.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { readJsonBody, sendJson } from "../respond.ts";
import { requireSafeSegment, requireWindowParams } from "../validate.ts";

/** One entry is a handful of short fields; anything larger is a malformed client. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * POST /api/v1/projects/:project/spend
 *
 * What a batch of ccqa invocations cost, as the job that ran them reported it —
 * the number a budget reads instead of summing runs (ADR-0017).
 */
export function createRecordSpendHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, RecordSpendRequestSchema, "spend body");
    const entry = await storage.spend.append(project, {
      id: randomUUID(),
      // Normalized to UTC whatever offset the caller wrote, so every stored
      // entry orders and windows against the same clock.
      at: new Date(body.at ?? Date.now()).toISOString(),
      costUsd: body.costUsd,
      label: body.label,
      ...(body.ciRunId ? { ciRunId: body.ciRunId } : {}),
      ...(body.runUrl ? { runUrl: body.runUrl } : {}),
    });
    sendJson(ctx.res, 201, entry);
  };
}

/** GET /api/v1/projects/:project/spend?since=&until= — newest first, plus the window's total. */
export function createGetSpendHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const window = requireWindowParams(ctx.url);
    const entries = await storage.spend.list(project, window);
    sendJson(ctx.res, 200, {
      project,
      since: window.since ?? null,
      until: window.until ?? null,
      totalUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
      entries,
    } satisfies SpendLogResponse);
  };
}
