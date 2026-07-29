import type { RerunReport } from "../../contract/schema.ts";
import { requireSpecTargets } from "../../core/perspectives-specs.ts";
import { deployRef } from "../../core/deploy-range.ts";
import { computeRerun } from "../../core/rerun.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects/:project/rerun?profile=
 *
 * Per spec: what should happen to it next, and why? Set arithmetic over the
 * spec ledger, the profile's deploy log and each deploy's per-spec touch
 * verdicts recorded by `ccqa select-specs` (ADR-0010, ADR-0011), plus the
 * drift ledger. The answer is derived from two axes the hub keeps apart — what
 * the audit says about the deployed commit, and how the last run ended — so a
 * red spec and one a deploy invalidated do not collapse into the same value.
 * The spec ledger is read across every branch: a run exercises the deployed
 * environment whatever branch its code came from.
 */
export function createGetRerunHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = requireProfileParam(ctx.url);

    const [specs, ledger, log, touchIndex, drift] = await Promise.all([
      requireSpecTargets(storage.perspectives, project, "which specs need a re-run"),
      storage.ledger.getMerged(project, profile),
      storage.deploys.getLog(project, profile),
      storage.deploys.getTouchIndex(project, profile),
      // Not profile-scoped: whether a spec still describes the code is a
      // question about the repository, not about an environment (ADR-0013).
      storage.driftLedger.getMerged(project),
    ]);
    const head = log.entries[log.entries.length - 1];

    sendJson(ctx.res, 200, {
      project,
      profile,
      deployHead: head ? deployRef(head) : null,
      specs: computeRerun({ specs, ledger, log, touchIndex, drift }),
    } satisfies RerunReport);
  };
}
