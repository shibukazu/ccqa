import type { DriftLedgerResponse } from "../../contract/schema.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects/:project/drift
 *
 * Every spec's last `ccqa drift --push` audit, keyed by "feature/spec". No
 * `?profile=` — drift asks whether a spec still describes the code, which
 * has nothing to do with which environment is running it, unlike the
 * `/rerun` and `/last-green` endpoints. Merged across every branch (newest
 * `at` wins per key), the same approximation `getMerged` makes for the spec
 * ledger: an audit is a property of the code at a commit, not of a branch.
 */
export function createGetDriftLedgerHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const ledger = await storage.driftLedger.getMerged(project);
    sendJson(ctx.res, 200, { project, specs: ledger.specs } satisfies DriftLedgerResponse);
  };
}
