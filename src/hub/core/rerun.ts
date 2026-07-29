import type {
  AuditState,
  DeployLog,
  DriftLedger,
  ExecutionState,
  RerunUnknownReason,
  SpecLedger,
  SpecLedgerEntry,
  SpecRerun,
  SpecTouchIndex,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import { auditNeed } from "./audit-need.ts";
import { buildRange, freshness, type Freshness, type RangeLookup } from "./deploy-range.ts";
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
}

export function computeRerun(input: RerunInput): Record<string, SpecRerun> {
  const { specs, ledger, log, touchIndex, drift } = input;
  const range = buildRange(log, touchIndex);
  // Nothing recorded for this profile at all: neither a run nor a deploy. A
  // profile-wide fact, so it replaces the derived answer without touching the
  // axes — those stay per-spec, or the same spec would read differently
  // depending on whether some *other* spec had a run. `green` is checked
  // separately from `run` because a pre-ledger document migrates as greens
  // with no runs.
  const nothingRecorded =
    log.entries.length === 0 &&
    Object.keys(ledger.run).length === 0 &&
    Object.keys(ledger.green).length === 0;

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    const audit = auditState(drift, spec.key, range);
    const execution = executionState(coords);
    const derived = nothingRecorded
      ? ({ verdict: "unanswerable", reason: "notEvaluated" } as const)
      : decide(audit, execution, coords.lastRun, (sha) => freshness(sha, spec.key, range));
    out[spec.key] = { ...derived, ...audit, execution, ...coords };
  }
  return out;
}

/**
 * Axis 1, derived from the same freshness answer `--only-hub-audit-needed`
 * reads. The label only speaks once the audit is known to be current: a
 * verdict about an older commit says nothing about the one running now.
 */
function auditState(
  drift: DriftLedger,
  key: string,
  range: RangeLookup,
): { audit: AuditState; driftLabel?: Exclude<DriftLabel, "UNKNOWN">; reason?: RerunUnknownReason } {
  const need = auditNeed(drift, key, range);
  switch (need.because) {
    case "neverAudited":
    case "deployReached":
      return { audit: "checking" };
    case "cannotTell":
      return { audit: "cannotTell", ...(need.reason ? { reason: need.reason } : {}) };
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
 * Axis 2. The red bucket is compared by run id rather than by timestamp
 * because both buckets advance from the same terminal-run trigger, so the run
 * that wrote `run` wrote exactly one of `green` or `red`.
 */
function executionState(coords: {
  lastRun: SpecLedgerEntry | null;
  lastRed: SpecLedgerEntry | null;
}): ExecutionState {
  if (!coords.lastRun) return "neverRun";
  if (coords.lastRed && coords.lastRed.runId === coords.lastRun.runId) return "failed";
  return "passed";
}

/**
 * The derived answer, evaluated in order. Order is the whole design: a failed
 * spec is answered before its age is considered, because re-running it teaches
 * nothing until the code it exercises moves.
 */
function decide(
  audit: { audit: AuditState; reason?: RerunUnknownReason },
  execution: ExecutionState,
  lastRun: SpecLedgerEntry | null,
  since: (baselineSha: string) => Freshness,
): Pick<SpecRerun, "verdict" | "reason" | "touchedBy" | "touchedByDeploy"> {
  // The deploy log could not place the audit, so it cannot place the run
  // either — they read the same log.
  switch (audit.audit) {
    case "cannotTell":
      return unanswerable(audit.reason!);
    case "checking":
      return { verdict: "inProgress" };
    case "drifted":
    case "undecided":
      return { verdict: "needsRepair" };
    case "clean":
      break;
    default: {
      const unreachable: never = audit.audit;
      throw new Error(`unhandled audit state: ${String(unreachable)}`);
    }
  }
  switch (execution) {
    case "failed":
      return { verdict: "needsRepair" };
    case "passed":
    case "neverRun":
      break;
    default: {
      const unreachable: never = execution;
      throw new Error(`unhandled execution state: ${String(unreachable)}`);
    }
  }
  if (!lastRun) return { verdict: "rerunNeeded" };
  if (lastRun.deployedShaAmbiguous) return unanswerable("ambiguousDeployedSha");
  if (!lastRun.deployedSha) return unanswerable("unknownDeployedSha");

  const answer = since(lastRun.deployedSha);
  if (answer.kind === "unanswerable") return unanswerable(answer.reason);
  if (answer.kind === "current") return { verdict: "verified" };
  return {
    verdict: "rerunNeeded",
    ...(answer.touchedBy ? { touchedBy: answer.touchedBy } : {}),
    touchedByDeploy: answer.touchedByDeploy,
  };
}

function unanswerable(reason: RerunUnknownReason): { verdict: "unanswerable"; reason: RerunUnknownReason } {
  return { verdict: "unanswerable", reason };
}
