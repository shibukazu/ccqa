import { HubApiError, type HubClient } from "../hub-client/index.ts";
import type { AuditNeed, AuditNeedReport } from "../hub/contract/schema.ts";

/**
 * `ccqa audit --only-hub-audit-needed`: ask the hub which specs a deploy has
 * landed on since the audit last read them.
 *
 * The mirror of `--only-hub-rerun-needed`, with the opposite default. An audit
 * costs cents where a live run costs dollars, so every "I cannot tell" is
 * audited rather than skipped, and a spec that was never audited is audited
 * unconditionally — there is no baseline for a diff to narrow away, which is
 * how a spec no deploy ever reached could otherwise sit un-audited forever.
 */

/** One spec, as `collectTargets` yields them. */
export interface AuditTarget {
  featureName: string;
  specName: string;
}

export class AuditSelectionError extends Error {}

export async function fetchAuditNeed(
  hub: HubClient,
  project: string,
  profile: string,
): Promise<AuditNeedReport> {
  try {
    return await hub.getAuditNeed(project, { profile });
  } catch (err) {
    if (err instanceof HubApiError && err.status === 404) {
      throw new AuditSelectionError(
        err.code === "no_perspectives"
          ? `--only-hub-audit-needed: project "${project}" has no perspectives document on the hub, so no spec ` +
            `is registered to compare against a deploy. Run \`ccqa perspectives\` first.`
          : `--only-hub-audit-needed: this hub does not serve audit-need answers — upgrade it, or select ` +
            `with --only-affected-by <ref> instead.`,
      );
    }
    throw new AuditSelectionError(
      `--only-hub-audit-needed: could not ask the hub which specs need auditing: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface AuditSelection {
  selected: AuditTarget[];
  /** "2 neverAudited, 3 deployReached, 1 cannotTell" — every selected spec accounted for. */
  summary: string;
}

/** Reported worst-known-first, so the line leads with what has never been looked at. */
const SUMMARY_ORDER: readonly AuditNeed["because"][] = [
  "neverAudited",
  "cannotTell",
  "deployReached",
  "current",
];

export function selectSpecsNeedingAudit(
  targets: readonly AuditTarget[],
  report: AuditNeedReport,
): AuditSelection {
  const counts = new Map<AuditNeed["because"], number>();
  const selected: AuditTarget[] = [];
  for (const target of targets) {
    // A spec the perspectives document does not list has no answer, and no
    // baseline either — the same position as one never audited.
    const need = report.specs[`${target.featureName}/${target.specName}`] ??
      ({ needed: true, because: "neverAudited", auditedAt: null } satisfies AuditNeed);
    counts.set(need.because, (counts.get(need.because) ?? 0) + 1);
    if (need.needed) selected.push(target);
  }
  const summary = SUMMARY_ORDER.filter((b) => counts.has(b))
    .map((b) => `${counts.get(b)} ${b}`)
    .join(", ");
  return { selected, summary };
}
