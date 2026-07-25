import type { LedgerResponse } from "../../contract/schema.ts";
import { emptyLedger } from "../../core/spec-ledger.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";
import { requireBranch } from "./runs.ts";

/**
 * GET /api/v1/projects/:project/last-green?profile=&branch=&fallbackBranch=
 *
 * Returns the spec ledger for one project/profile, keyed by "feature/spec".
 * `branch` is the caller's current branch; `fallbackBranch` (optional,
 * typically the default branch) is overlaid *under* it, so a PR branch with no
 * entries of its own still inherits the default branch's baselines while its
 * own take precedence. One round trip serves the whole run.
 *
 * `entries` is the green bucket and keeps that exact meaning — older CLIs read
 * `entry.gitHead` from it as "the commit this spec last passed at". The
 * last-run and last-red buckets are siblings, not a redefinition.
 */
export function createGetLastGreenHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);
    const branch = requireBranch(ctx.url.searchParams.get("branch"));
    if (!branch) throw new HttpError(400, "missing_param", "branch query parameter is required");
    const fallbackBranch = requireBranch(ctx.url.searchParams.get("fallbackBranch"));

    const [primary, fallback] = await Promise.all([
      storage.ledger.get(project, profile, branch),
      fallbackBranch && fallbackBranch !== branch
        ? storage.ledger.get(project, profile, fallbackBranch)
        : Promise.resolve(emptyLedger()),
    ]);
    sendJson(ctx.res, 200, {
      entries: { ...fallback.green, ...primary.green },
      lastRun: { ...fallback.run, ...primary.run },
      lastRed: { ...fallback.red, ...primary.red },
    } satisfies LedgerResponse);
  };
}
