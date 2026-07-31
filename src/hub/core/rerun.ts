import type {
  AuditState,
  DeployLog,
  DriftLedger,
  ExecutionState,
  RerunUnknownReason,
  SpecLedger,
  SpecLedgerEntry,
  SpecLock,
  SpecLocks,
  SpecRerun,
  SpecTouchIndex,
  SpecVerdict,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import { auditNeed } from "./audit-need.ts";
import { buildRange, freshness, type Freshness, type RangeLookup } from "./deploy-range.ts";
import { heldBy } from "./locks.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "What should happen to this spec next?" — pure set arithmetic over data the
 * hub already stores (ADR-0010).
 *
 * Two independent axes, one derived answer. Neither axis determines the other
 * — a spec can be clean and stale, or drifted and freshly run — so collapsing
 * them into one value loses exactly the case that matters.
 */
export interface RerunInput {
  /** Every spec in the project's perspectives document. */
  specs: SpecTarget[];
  /** The profile's ledger, merged across branches. */
  ledger: SpecLedger;
  log: DeployLog;
  touchIndex: SpecTouchIndex;
  /** The project's drift ledger, keyed by spec. Carries the commit each audit read. */
  drift: DriftLedger;
  /** Who is working on what right now. Expired holds read as free. */
  locks: SpecLocks;
  /** Compared against each hold's expiry. Passed in so the answer is reproducible in tests. */
  now: Date;
}

export function computeRerun(input: RerunInput): Record<string, SpecRerun> {
  const { specs, ledger, log, touchIndex, drift, locks, now } = input;
  const range = buildRange(log, touchIndex);

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    const audit = auditState(drift, spec.key, range);
    const execution = executionState(coords, (sha) => freshness(sha, spec.key, range));
    const held = heldBy(locks, spec.key, now);
    out[spec.key] = {
      verdict: decide(audit.audit, execution.execution, held),
      ...audit,
      ...execution,
      heldBy: held,
      ...coords,
    };
  }
  return out;
}

/**
 * Axis 1, derived from the same freshness answer `--only-hub-audit-needed`
 * reads. The label only speaks once the audit is known to be current: a
 * verdict about an older commit says nothing about the one running now.
 *
 * A commit the log cannot place is `due` like any other: a deploy we cannot
 * rule out is treated as having landed (ADR-0014). The hole is kept as an
 * annotation so the answer stays explicable.
 */
function auditState(
  drift: DriftLedger,
  key: string,
  range: RangeLookup,
): {
  audit: AuditState;
  driftLabel?: Exclude<DriftLabel, "UNKNOWN">;
  auditAssumedReached?: RerunUnknownReason;
} {
  const need = auditNeed(drift, key, range);
  switch (need.because) {
    case "neverAudited":
    case "deployReached":
      return { audit: "due" };
    case "cannotTell":
      return { audit: "due", ...(need.reason ? { auditAssumedReached: need.reason } : {}) };
    case "current": {
      const label = drift.specs[key]!.label;
      if (label === null) return { audit: "clean" };
      if (label === "UNKNOWN") return { audit: "undecided" };
      return { audit: "drifted", driftLabel: label };
    }
    default: {
      const unreachable: never = need.because;
      throw new Error(`unhandled audit need: ${String(unreachable)}`);
    }
  }
}

/**
 * Axis 2: how the last run ended, and whether a deploy has overtaken it. The
 * red bucket is compared by run id rather than by timestamp because both
 * buckets advance from the same terminal-run trigger, so the run that wrote
 * `run` wrote exactly one of `green` or `red`.
 *
 * `failed` outranks `stale`: a red result is current information whatever has
 * deployed since, and re-running it teaches nothing until someone repairs it.
 */
function executionState(
  coords: { lastRun: SpecLedgerEntry | null; lastRed: SpecLedgerEntry | null },
  since: (baselineSha: string) => Freshness,
): Pick<SpecRerun, "execution" | "executionAssumedReached" | "touchedBy" | "touchedByDeploy"> {
  const { lastRun, lastRed } = coords;
  if (!lastRun) return { execution: "neverRun" };
  if (lastRed && lastRed.runId === lastRun.runId) return { execution: "failed" };
  // A run the log cannot place is stale, not discarded: the result is still
  // worth reading, only its currency is void (ADR-0014).
  if (lastRun.deployedShaAmbiguous) return assumedReached("ambiguousDeployedSha");
  if (!lastRun.deployedSha) return assumedReached("unknownDeployedSha");

  const answer = since(lastRun.deployedSha);
  if (answer.kind === "unanswerable") return assumedReached(answer.reason);
  if (answer.kind === "current") return { execution: "passed" };
  return {
    execution: "stale",
    ...(answer.touchedBy ? { touchedBy: answer.touchedBy } : {}),
    touchedByDeploy: answer.touchedByDeploy,
  };
}

function assumedReached(
  reason: RerunUnknownReason,
): { execution: "stale"; executionAssumedReached: RerunUnknownReason } {
  return { execution: "stale", executionAssumedReached: reason };
}

/**
 * The derived answer: a total function of the two axes plus whether a job
 * holds the spec. Nothing else is consulted — an axis that needed a third
 * input to be read is an axis that cannot be shown next to the verdict as its
 * reason.
 */
function decide(audit: AuditState, execution: ExecutionState, held: SpecLock | null): SpecVerdict {
  // A job already has this spec. Nothing below is worth asking: whatever the
  // answer, acting on it would race the job that is on it.
  if (held) return "inProgress";
  switch (audit) {
    case "due":
      return "inProgress";
    case "drifted":
    case "undecided":
      return "needsRepair";
    case "clean":
      break;
    default: {
      const unreachable: never = audit;
      throw new Error(`unhandled audit state: ${String(unreachable)}`);
    }
  }
  switch (execution) {
    case "failed":
      return "needsRepair";
    case "stale":
    case "neverRun":
      return "rerunNeeded";
    case "passed":
      return "verified";
    default: {
      const unreachable: never = execution;
      throw new Error(`unhandled execution state: ${String(unreachable)}`);
    }
  }
}
