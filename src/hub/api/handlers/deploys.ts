import {
  RecordDeployRequestSchema,
  type DeployEntry,
  type DeployLogResponse,
  type DeploySelection,
} from "../../contract/schema.ts";
import { foldTouchIndex } from "../../core/deploy-log.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { errMsg, readJsonBody, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/** `changedPaths` for a wide refactor can run to tens of thousands of entries. */
const MAX_DEPLOY_BODY_BYTES = 8 * 1024 * 1024;

/**
 * POST /api/v1/projects/:project/deploys?profile=
 *
 * The consuming deploy job tells the hub what it shipped. This is the input
 * that makes "needs re-run" answerable at all: the hub has no checkout and
 * never calls a git host, so it cannot work out what changed on its own
 * (ADR-0010). The log is per-profile because two environments sit at
 * different commits.
 */
export function createRecordDeployHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);
    const { sha, previousSha, changedPaths, selection, ref, runUrl } = await readJsonBody(
      ctx.req,
      MAX_DEPLOY_BODY_BYTES,
      RecordDeployRequestSchema,
      "deploy body",
    );

    const entry = await storage.deploys.append(project, profile, {
      sha,
      previousSha: previousSha ?? null,
      at: new Date().toISOString(),
      ...(ref ? { ref } : {}),
      ...(runUrl ? { runUrl } : {}),
      changedPaths: changedPaths ?? null,
      // Set below, once the fold has actually landed. Claiming it here is what
      // made a lost fold read as `verified` instead of `unanswerable`: the flag
      // is exactly what closes the "no selection in range" escape hatch.
      hasSelection: false,
    });
    const folded = selection !== undefined
      && await foldIntoTouchIndex(storage, project, profile, entry, selection);
    if (folded) {
      await storage.deploys.confirmSelection(project, profile, entry.index);
    }

    sendJson(ctx.res, 201, { ...entry, hasSelection: folded === true });
  };
}

/**
 * Record what this deploy's selection decided, so a later read can answer each
 * spec's own range with two integer comparisons.
 *
 * It does not fail the request: the log is the record of what shipped and has
 * to land even if the fold cannot. What a lost fold must not do is *look* like
 * a recorded one — so the caller only marks the entry `hasSelection` when this
 * returns true, and the range reads as unresolved otherwise. The client is told
 * by the entry it gets back.
 */
async function foldIntoTouchIndex(
  storage: HubStorage,
  project: string,
  profile: string,
  entry: DeployEntry,
  selection: DeploySelection,
): Promise<boolean> {
  try {
    await storage.deploys.updateTouchIndex(project, profile, (current) =>
      foldTouchIndex(current, entry, selection),
    );
    return true;
  } catch (err) {
    console.error(
      `hub: touch-index fold failed for deploy "${entry.sha}" of "${project}/${profile}": ${errMsg(err)}`,
    );
    return false;
  }
}

/** GET /api/v1/projects/:project/deploys?profile=&limit= — the retained log, oldest first. */
export function createGetDeployLogHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const log = await storage.deploys.getLog(project, requireProfileParam(ctx.url));
    const limit = Number(ctx.url.searchParams.get("limit"));
    const entries = Number.isFinite(limit) && limit > 0 ? log.entries.slice(-Math.floor(limit)) : log.entries;
    sendJson(ctx.res, 200, { entries, nextIndex: log.nextIndex } satisfies DeployLogResponse);
  };
}
