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
      hasSelection: selection !== undefined,
    });
    if (selection !== undefined) await foldIntoTouchIndex(storage, project, profile, entry, selection);

    sendJson(ctx.res, 201, entry);
  };
}

/**
 * Record what this deploy's selection decided, so a later read can answer each
 * spec's own range with two integer comparisons.
 *
 * Deliberately after the append, and it does not fail the request: the log is
 * the record of what shipped and has to land even if the fold cannot. A lost
 * fold shows up as specs reporting `unknown` rather than as a wrong `notNeeded`
 * — the entry is already marked `hasSelection`, so the read side knows the
 * range is unresolved either way.
 */
async function foldIntoTouchIndex(
  storage: HubStorage,
  project: string,
  profile: string,
  entry: DeployEntry,
  selection: DeploySelection,
): Promise<void> {
  try {
    await storage.deploys.updateTouchIndex(project, profile, (current) =>
      foldTouchIndex(current, entry, selection),
    );
  } catch (err) {
    console.error(
      `hub: touch-index fold failed for deploy "${entry.sha}" of "${project}/${profile}": ${errMsg(err)}`,
    );
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
