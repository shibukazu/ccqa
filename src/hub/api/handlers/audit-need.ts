import type { AuditNeedReport } from "../../contract/schema.ts";
import { computeAuditNeed } from "../../core/audit-need.ts";
import { loadSpecTargets } from "../../core/perspectives-specs.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects/:project/audit-needed?profile=
 *
 * Per spec: has a deploy landed on the code it covers since the audit last
 * read it? The mirror of the re-run verdict, started from the drift ledger's
 * `gitHead` instead of the last run's deployed sha.
 *
 * Profile-scoped even though the drift ledger is not (ADR-0013): the question
 * is about deploys, and the deploy log is per-profile.
 */
export function createGetAuditNeedHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);

    const [specs, log, touchIndex, drift] = await Promise.all([
      loadSpecTargets(storage.perspectives, project),
      storage.deploys.getLog(project, profile),
      storage.deploys.getTouchIndex(project, profile),
      storage.driftLedger.getMerged(project),
    ]);
    if (specs === null) {
      throw new HttpError(
        404,
        "no_perspectives",
        `no perspectives stored for project "${project}" — push one with \`ccqa perspectives\` before asking which specs need auditing`,
      );
    }
    const head = log.entries[log.entries.length - 1];

    sendJson(ctx.res, 200, {
      project,
      profile,
      deployHead: head ? { index: head.index, sha: head.sha, at: head.at } : null,
      specs: computeAuditNeed({ specs, log, touchIndex, drift }),
    } satisfies AuditNeedReport);
  };
}
