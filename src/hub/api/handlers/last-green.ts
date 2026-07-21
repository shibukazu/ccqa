import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects/:project/last-green?profile=&branch=&fallbackBranch=
 *
 * Returns the last-green ledger entries for one project/profile, keyed by
 * "feature/spec". `branch` is the caller's current branch; `fallbackBranch`
 * (optional, typically the default branch) is overlaid *under* it, so a PR
 * branch with no greens of its own still inherits the default branch's
 * baselines while its own greens take precedence. One round trip serves the
 * whole run.
 */
export function createGetLastGreenHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireSafeSegment(ctx.url.searchParams.get("profile") ?? "default", "profile");
    const branch = ctx.url.searchParams.get("branch");
    if (!branch) throw new HttpError(400, "missing_param", "branch query parameter is required");
    const fallbackBranch = ctx.url.searchParams.get("fallbackBranch");

    const primary = await storage.lastGreen.get(project, profile, branch);
    const fallback =
      fallbackBranch && fallbackBranch !== branch
        ? await storage.lastGreen.get(project, profile, fallbackBranch)
        : {};
    sendJson(ctx.res, 200, { entries: { ...fallback, ...primary } });
  };
}
