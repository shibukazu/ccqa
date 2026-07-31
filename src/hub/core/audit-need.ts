import type {
  AuditNeed,
  DeployLog,
  DriftLedger,
  SpecLocks,
  SpecTouchIndex,
} from "../contract/schema.ts";
import { buildRange, freshness, type RangeLookup } from "./deploy-range.ts";
import { heldBy } from "./locks.ts";
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
 * Everything but `current` audits, including a baseline the deploy log cannot
 * place: an unplaceable range is treated as reached on both sides now
 * (ADR-0014), so this and the re-run verdict differ in wording, not in what
 * they select.
 */
/**
 * The freshness half of the answer. `held` is not here: whether a job is on
 * the spec is a fact about locks, added by the caller that reads them, and
 * keeping it out lets `auditState` switch over exactly the values this can
 * return.
 */
export type AuditFreshness = AuditNeed & {
  because: Exclude<AuditNeed["because"], "held">;
};

export function auditNeed(drift: DriftLedger, key: string, range: RangeLookup): AuditFreshness {
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
  /** Who is working on what right now. A held spec is not offered again. */
  locks: SpecLocks;
  now: Date;
}

export function computeAuditNeed(input: AuditNeedInput): Record<string, AuditNeed> {
  const range = buildRange(input.log, input.touchIndex);
  return Object.fromEntries(
    input.specs.map((spec) => [
      spec.key,
      // A job already on this spec answers for it. Offering it again would
      // have two audits writing the same ledger entry.
      heldBy(input.locks, spec.key, input.now)
        ? ({ because: "held" } satisfies AuditNeed)
        : auditNeed(input.drift, spec.key, range),
    ]),
  );
}
