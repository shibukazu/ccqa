import type {
  AuditNeed,
  DeployLog,
  DriftLedger,
  SpecTouchIndex,
} from "../contract/schema.ts";
import { buildRange, freshness } from "./deploy-range.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "Does this spec need auditing?" — the same range arithmetic the re-run
 * verdict runs, started from the commit the audit read instead of the deploy
 * the last run exercised.
 *
 * The two default in opposite directions, and the asymmetry is deliberate: an
 * audit costs cents and a live run costs dollars, so the audit does the work
 * when it cannot tell and the run declines to.
 *
 * A spec with no audit at all is needed unconditionally. There is no baseline
 * to diff from, so `ccqa select-specs` has nothing to say about it — which is
 * why a spec that no deploy ever reached could otherwise sit un-audited
 * forever.
 */
export interface AuditNeedInput {
  /** Every spec in the project's perspectives document. */
  specs: SpecTarget[];
  log: DeployLog;
  touchIndex: SpecTouchIndex;
  /** The project's drift ledger. Carries the commit each audit read. */
  drift: DriftLedger;
}

export function computeAuditNeed(input: AuditNeedInput): Record<string, AuditNeed> {
  const { specs, log, touchIndex, drift } = input;
  const range = buildRange(log, touchIndex);

  const out: Record<string, AuditNeed> = {};
  for (const spec of specs) {
    const entry = drift.specs[spec.key];
    if (!entry) {
      out[spec.key] = { needed: true, because: "neverAudited", auditedAt: null };
      continue;
    }
    const since = freshness(entry.gitHead, spec.key, range);
    const auditedAt = entry.gitHead;
    if (since.kind === "current") {
      out[spec.key] = { needed: false, because: "current", auditedAt };
    } else if (since.kind === "touched") {
      out[spec.key] = {
        needed: true,
        because: "deployReached",
        auditedAt,
        ...(since.touchedByDeploy ? { touchedByDeploy: since.touchedByDeploy } : {}),
      };
    } else {
      out[spec.key] = { needed: true, because: "cannotTell", reason: since.reason, auditedAt };
    }
  }
  return out;
}
