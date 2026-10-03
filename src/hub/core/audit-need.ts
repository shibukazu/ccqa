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

export function auditNeed(
  drift: DriftLedger,
  spec: SpecTarget,
  range: RangeLookup,
  deployTimes: Map<string, string>,
): AuditFreshness {
  const entry = drift.specs[spec.key];
  if (!entry) return { because: "neverAudited" };

  const since = freshness(entry.gitHead, spec.key, range);
  switch (since.kind) {
    case "current":
      // A spec edited after the audit's baseline is due like one a deploy
      // reached. `deployReached` rather than a new value: clients parse
      // `because` as a closed enum, and an unknown one fails the whole answer.
      return specMovedSince(spec.changedAt, entry.gitHead, entry.at, deployTimes)
        ? { because: "deployReached" }
        : { because: "current" };
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

/**
 * When each deployed commit reached the environment. A baseline read at that
 * commit cannot have seen anything committed after it was deployed.
 */
export function deployedAt(log: DeployLog): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of log.entries) out.set(entry.sha, entry.at);
  return out;
}

/**
 * Has the spec moved since the baseline was taken?
 *
 * A verdict is a claim about a (spec, product) pair, so either side moving
 * invalidates it. The deploy log covers the product side; this covers the
 * other one. Without it a spec repaired and merged stays `needsRepair` until
 * a deploy happens to reach it, and a run that passed against the previous
 * spec keeps answering `verified` for the new one.
 *
 * Compared against when the baseline commit was *deployed*, not when the audit
 * or run happened: the tree read at that commit predates its deployment, so an
 * edit after it is definitely not in it. Falls back to the baseline's own
 * timestamp when the log cannot place the commit.
 *
 * One-directional. A later edit time proves the baseline is stale; an earlier
 * one proves nothing, and this answers false rather than guessing.
 */
export function specMovedSince(
  changedAt: string | undefined,
  baselineSha: string | null,
  baselineAt: string,
  deployTimes: Map<string, string>,
): string | null {
  if (!changedAt) return null;
  const cutoff = (baselineSha && deployTimes.get(baselineSha)) || baselineAt;
  return isLater(changedAt, cutoff) ? changedAt : null;
}

/**
 * Compared as instants, never as strings: a spec's edit time carries its
 * committer's offset, and `+09:00` sorts after `Z` for an earlier moment.
 * An unparseable side answers false, the same as a missing one.
 */
export function isLater(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
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
  const deployTimes = deployedAt(input.log);
  return Object.fromEntries(
    input.specs.map((spec) => [
      spec.key,
      // A job already on this spec answers for it. Offering it again would
      // have two audits writing the same ledger entry.
      heldBy(input.locks, spec.key, input.now)
        ? ({ because: "held" } satisfies AuditNeed)
        : auditNeed(input.drift, spec, range, deployTimes),
    ]),
  );
}
