import {
  RecordDeployRequestSchema,
  type DeployEntry,
  type DeployLogResponse,
} from "../../contract/schema.ts";
import { foldTouchIndex } from "../../core/deploy-log.ts";
import { loadSpecTargets } from "../../core/perspectives-specs.ts";
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
    const { sha, previousSha, changedPaths, ref, runUrl } = await readJsonBody(
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
    });
    await foldIntoTouchIndex(storage, project, profile, entry, changedPaths ?? null);

    sendJson(ctx.res, 201, entry);
  };
}

/**
 * Record which specs this deploy touched, matched against the full
 * `changedPaths` before the stored entry's bounded copy is all that is left.
 *
 * Best-effort and deliberately after the append: the log is the record of what
 * shipped, the index is a derived accelerator, and losing the fold costs
 * precision on truncated entries — not correctness.
 */
async function foldIntoTouchIndex(
  storage: HubStorage,
  project: string,
  profile: string,
  entry: DeployEntry,
  changedPaths: string[] | null,
): Promise<void> {
  try {
    const targets = await loadSpecTargets(storage.perspectives, project);
    if (!targets || targets.length === 0) return;
    await storage.deploys.updateTouchIndex(project, profile, (current) =>
      foldTouchIndex(current, entry, changedPaths, targets),
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
