import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError } from "../hub-client/index.ts";
import { AuditNeedReportSchema, type AuditNeed, type AuditNeedReport } from "../hub/contract/schema.ts";
import { needsAudit } from "../hub/core/audit-need.ts";
import { RunUsageError, errMessage } from "../run/errors.ts";
import { explainHubNotFound, formatCounts, rankedOrder } from "../run/hub-selection.ts";
import { specKey, type SpecRef } from "../store/index.ts";

/**
 * `ccqa audit --only-hub-audit-needed`: ask the hub which specs a deploy has
 * landed on since the audit last read them. The mirror of
 * `--only-hub-rerun-needed`, with the opposite default — see `auditNeed`.
 */
const FLAG = "--only-hub-audit-needed";

export async function fetchAuditNeed(ctx: HubContext, profile: string): Promise<AuditNeedReport> {
  try {
    // Parsed, not trusted: an older hub that happens to route this path would
    // answer a shape whose every field reads `undefined`, and the sweep would
    // narrow to nothing rather than fail.
    const parsed = AuditNeedReportSchema.safeParse(await ctx.hub.getAuditNeed(ctx.project, { profile }));
    if (!parsed.success) {
      throw new RunUsageError(
        `${FLAG}: this hub's answer is not in a shape this ccqa understands — it is likely older ` +
          `than this CLI. Upgrade the hub, or select with --only-affected-by <ref> instead.`,
      );
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof RunUsageError) throw err;
    if (err instanceof HubApiError && err.status === 404) {
      throw new RunUsageError(explainHubNotFound(FLAG, ctx.project, err, "which specs need auditing"));
    }
    throw new RunUsageError(`${FLAG}: could not ask the hub which specs need auditing: ${errMessage(err)}`);
  }
}

export interface AuditSelection {
  selected: SpecRef[];
  /** "2 neverAudited, 3 deployReached, 1 cannotTell" — every offered spec accounted for. */
  summary: string;
}

/** Worst-known-first, so the line leads with what has never been looked at. */
const SUMMARY_ORDER = rankedOrder<AuditNeed["because"]>({
  neverAudited: 0, cannotTell: 1, deployReached: 2, current: 3,
});

export function selectSpecsNeedingAudit(
  targets: readonly SpecRef[],
  report: AuditNeedReport,
): AuditSelection {
  const counts = new Map<AuditNeed["because"], number>();
  const selected: SpecRef[] = [];
  for (const target of targets) {
    // A spec the perspectives document does not list has no answer and no
    // baseline either — the same position as one never audited.
    const need = report.specs[specKey(target)] ?? ({ because: "neverAudited" } satisfies AuditNeed);
    counts.set(need.because, (counts.get(need.because) ?? 0) + 1);
    if (needsAudit(need)) selected.push(target);
  }
  return { selected, summary: formatCounts(SUMMARY_ORDER, counts) };
}
