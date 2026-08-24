import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendBytes, sendJson } from "../respond.ts";
import { requireSafeRelPath, requireSafeSegment } from "../validate.ts";
import { DEFAULT_MAX_SOURCEMAP_COMMITS, sweepSourceMapRetention } from "../../core/retention.ts";

/**
 * A source map is roughly the size of the code it describes, and a single
 * bundle chunk can be a few MB. Generous, but still a ceiling: a push is many
 * small requests rather than one archive, so no single body should approach it.
 */
const MAX_MAP_BYTES = 32 * 1024 * 1024;

export function createPutSourceMapHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const commit = requireSafeSegment(ctx.params.commit!, "commit");
    const assetPath = requireSafeRelPath(ctx.params.path!, "source map path");
    const body = await readBody(ctx.req, MAX_MAP_BYTES);
    await storage.sourceMaps.put(project, commit, assetPath, body);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

export function createGetSourceMapHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const commit = requireSafeSegment(ctx.params.commit!, "commit");
    const assetPath = requireSafeRelPath(ctx.params.path!, "source map path");
    const bytes = await storage.sourceMaps.read(project, commit, assetPath);
    if (!bytes) {
      throw new HttpError(404, "not_found", `no source map stored for "${assetPath}" at ${commit}`);
    }
    sendBytes(ctx.res, 200, bytes, "application/json; charset=utf-8");
  };
}

/**
 * Ends a push: everything for this commit has landed, so older commits can go.
 * Separate from the PUTs because a push is hundreds of them, and sweeping on
 * each would walk the whole project every time.
 */
export function createSweepSourceMapsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    await sweepSourceMapRetention(storage, project, DEFAULT_MAX_SOURCEMAP_COMMITS);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

export function createListSourceMapsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const commit = requireSafeSegment(ctx.params.commit!, "commit");
    sendJson(ctx.res, 200, { project, commit, paths: await storage.sourceMaps.list(project, commit) });
  };
}
