import type { AuditNeed, DeployLog, DriftLedger, SpecTouchIndex } from "../contract/schema.ts";
import { buildRange, freshness, type RangeLookup } from "./deploy-range.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "Does this spec need auditing?" — the freshness question the re-run verdict
 * asks, started from the commit the audit read instead of the deploy the last
 * run exercised.
 *
 * A spec with no audit at all needs one unconditionally: there is no baseline
 * to diff from, so `ccqa select-specs` has nothing to narrow it away with, and
 * a spec no deploy ever reached would otherwise stay un-audited forever.
 *
 * Everything but `current` audits. An audit costs cents where a live run costs
 * dollars, so this side does the work when it cannot tell and the re-run
 * verdict declines to.
 */
export function auditNeed(drift: DriftLedger, key: string, range: RangeLookup): AuditNeed {
  const entry = drift.specs[key];
  if (!entry) return { because: "neverAudited" };

  const since = freshness(entry.gitHead, key, range);
  switch (since.kind) {
    case "current":
      return { because: "current" };
    case "touched":
      return { because: "deployReached" };
    case "unanswerable":
      return { because: "cannotTell", reason: since.reason };
    default: {
      const unreachable: never = since;
      throw new Error(`unhandled freshness: ${String(unreachable)}`);
    }
  }
}

/** True for every answer but `current`. */
export function needsAudit(need: AuditNeed): boolean {
  return need.because !== "current";
}

export interface AuditNeedInput {
  /** Every spec in the project's perspectives document. */
  specs: SpecTarget[];
  log: DeployLog;
  touchIndex: SpecTouchIndex;
  /** The project's drift ledger. Carries the commit each audit read. */
  drift: DriftLedger;
}

export function computeAuditNeed(input: AuditNeedInput): Record<string, AuditNeed> {
  const range = buildRange(input.log, input.touchIndex);
  return Object.fromEntries(
    input.specs.map((spec) => [spec.key, auditNeed(input.drift, spec.key, range)]),
  );
}
