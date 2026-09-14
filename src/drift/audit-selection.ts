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

/**
 * Specs whose drift-ledger entry is still open. The hub's audit-need answer is
 * deploy-based, and a merged fix changes only the spec tree — no deploy lands
 * on the spec, so the hub would never call it due again and the entry would
 * stay open forever. A drifted spec is due until the audit itself clears it.
 *
 * `PRODUCT_BUG`/`ENVIRONMENT` are the exception, not `UNKNOWN`. Each of the
 * first two read the test case and found it faithful before naming something
 * else — the same reading `auditState` (src/hub/core/rerun.ts) gives them,
 * clean rather than drifted — and that something else lives outside the spec
 * tree, so no edit to the case can ever resolve them; counting them here would
 * spend a Claude call every sweep on a verdict a merged fix can never change.
 * `TEST_DRIFT`, `SPEC_CHANGE` and `UNKNOWN` all stay open: a person editing the
 * case — fixing the drift, rewriting the spec, or making an unclear one easier
 * to read — is exactly the kind of change this function exists to notice.
 *
 * Unreadable ledger degrades to the deploy-based answer alone: the sweep must
 * not die over the supplementary question.
 */
export async function fetchStillDrifted(ctx: HubContext): Promise<ReadonlySet<string>> {
  try {
    const ledger = await ctx.hub.getDriftLedger(ctx.project);
    return new Set(
      Object.entries(ledger.specs ?? {})
        .filter(([, entry]) => entry.label != null && entry.label !== "PRODUCT_BUG" && entry.label !== "ENVIRONMENT")
        .map(([key]) => key),
    );
  } catch {
    return new Set();
  }
}

type SelectionReason = AuditNeed["because"] | "stillDrifted";

/** Worst-known-first, so the line leads with what has never been looked at. */
const SUMMARY_ORDER = rankedOrder<SelectionReason>({
  neverAudited: 0, stillDrifted: 1, cannotTell: 2, deployReached: 3, held: 4, current: 5,
});

export function selectSpecsNeedingAudit(
  targets: readonly SpecRef[],
  report: AuditNeedReport,
  stillDrifted: ReadonlySet<string> = new Set(),
): AuditSelection {
  const counts = new Map<SelectionReason, number>();
  const selected: SpecRef[] = [];
  for (const target of targets) {
    const key = specKey(target);
    if (stillDrifted.has(key)) {
      counts.set("stillDrifted", (counts.get("stillDrifted") ?? 0) + 1);
      selected.push(target);
      continue;
    }
    // A spec the perspectives document does not list has no answer and no
    // baseline either — the same position as one never audited.
    const need = report.specs[key] ?? ({ because: "neverAudited" } satisfies AuditNeed);
    counts.set(need.because, (counts.get(need.because) ?? 0) + 1);
    if (needsAudit(need)) selected.push(target);
  }
  return { selected, summary: formatCounts(SUMMARY_ORDER, counts) };
}
