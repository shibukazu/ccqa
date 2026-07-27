import type { RerunReport } from "../../contract/schema.ts";
import { loadSpecTargets } from "../../core/perspectives-specs.ts";
import { computeRerun } from "../../core/rerun.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects/:project/rerun?profile=
 *
 * Per spec: is its last result still trustworthy? Set arithmetic over the spec
 * ledger, the profile's deploy log and each deploy's per-spec touch verdicts
 * recorded by `ccqa select-specs` (ADR-0010, ADR-0011). The ledger is read
 * across every branch: a run exercises the deployed environment whatever
 * branch its code came from.
 */
export function createGetRerunHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);

    const [specs, ledger, log, touchIndex] = await Promise.all([
      loadSpecTargets(storage.perspectives, project),
      storage.ledger.getMerged(project, profile),
      storage.deploys.getLog(project, profile),
      storage.deploys.getTouchIndex(project, profile),
    ]);
    if (specs === null) {
      // Distinct from the generic `not_found` an unrouted path returns: the
      // route exists, the project's perspectives document does not. Clients
      // tell "this hub is too old" from "push a perspectives document" by this
      // code alone, with no second probe request.
      throw new HttpError(
        404,
        "no_perspectives",
        `no perspectives stored for project "${project}" — push one with \`ccqa perspectives\` before asking which specs need a re-run`,
      );
    }
    const head = log.entries[log.entries.length - 1];

    sendJson(ctx.res, 200, {
      project,
      profile,
      deployHead: head ? { index: head.index, sha: head.sha, at: head.at } : null,
      specs: computeRerun({ specs, ledger, log, touchIndex }),
    } satisfies RerunReport);
  };
}
