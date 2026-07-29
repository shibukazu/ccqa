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
import { buildRange, freshness, type RangeLookup } from "./deploy-range.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "What should happen to this spec next?" — pure set arithmetic over data the
 * hub already stores (ADR-0010).
 *
 * Two independent axes, one derived answer. The audit axis says whether the
 * spec still describes the deployed code; the execution axis says what
 * happened the last time it ran. Neither determines the other — a spec can be
 * clean and stale, or drifted and freshly run — so collapsing them into one
 * value loses exactly the case that matters.
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
  // Nothing has ever been recorded for this profile: neither a run nor a
  // deploy. That is a different statement from "this spec has never run".
  // `green` is checked separately from `run` because a pre-ledger document
  // migrates as greens with no runs.
  const notEvaluated =
    log.entries.length === 0 &&
    Object.keys(ledger.run).length === 0 &&
    Object.keys(ledger.green).length === 0;
  const range = buildRange(log, touchIndex);

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    const { axis, dataProblem } = auditState(drift, spec.key, range);
    const execution = executionState(coords);
    out[spec.key] = {
      ...decide(axis, execution, coords, spec.key, range, notEvaluated, dataProblem),
      ...axis,
      execution,
      ...coords,
    };
  }
  return out;
}

/**
 * Axis 1. What the audit says about the *deployed* commit, which is not the
 * same as what its last run said: an audit that read an older commit has not
 * spoken about the code running now, so it reads as `checking` until a deploy
 * that reached this spec has been audited again.
 *
 * A missing ledger entry and a stale one collapse to the same answer on
 * purpose. To a reader asking "does this spec describe what is deployed", the
 * audit has not answered in either case.
 *
 * `dataProblem` is separate from both. When the deploy log cannot say whether
 * the audit is current, the honest answer is that nothing here can be
 * determined — folding that into `checking` would promise a resolution that
 * waiting will never bring.
 */
export function auditState(
  drift: DriftLedger,
  key: string,
  range: RangeLookup,
): { axis: { audit: AuditState; driftLabel?: DriftLabel }; dataProblem: RerunUnknownReason | null } {
  const entry = drift.specs[key];
  if (!entry) return { axis: { audit: "checking" }, dataProblem: null };
  const since = freshness(entry.gitHead, key, range);
  if (since.kind === "unanswerable") {
    return { axis: { audit: "checking" }, dataProblem: since.reason };
  }
  if (since.kind === "touched") return { axis: { audit: "checking" }, dataProblem: null };
  if (entry.label === null) return { axis: { audit: "clean" }, dataProblem: null };
  if (entry.label === "UNKNOWN") return { axis: { audit: "undecided" }, dataProblem: null };
  return { axis: { audit: "drifted", driftLabel: entry.label }, dataProblem: null };
}

/**
 * Axis 2. The outcome of the last execution, with no notion of age — how old
 * that execution is belongs to the deploy log, not here.
 *
 * The red bucket is compared by run id rather than by timestamp because both
 * buckets advance from the same terminal-run trigger, so the run that wrote
 * `run` is the one that wrote exactly one of `green` or `red`.
 */
function executionState(coords: Coords): ExecutionState {
  if (!coords.lastRun) return "neverRun";
  if (coords.lastRed && coords.lastRed.runId === coords.lastRun.runId) return "failed";
  return "passed";
}

/**
 * The derived answer, evaluated in order. Order is the whole design: a failed
 * spec is answered before its age is considered, because re-running it teaches
 * nothing until the code it exercises moves — the failure is already current
 * information.
 */
function decide(
  audit: { audit: AuditState },
  execution: ExecutionState,
  coords: Coords,
  key: string,
  range: RangeLookup,
  notEvaluated: boolean,
  auditDataProblem: RerunUnknownReason | null,
): Pick<SpecRerun, "verdict" | "reason" | "touchedBy" | "touchedByDeploy"> {
  if (notEvaluated) return { verdict: "unanswerable", reason: "notEvaluated" };
  // Before anything else: if the deploy log cannot place the audit, no answer
  // below it stands either — they all read the same log.
  if (auditDataProblem) return unanswerable(auditDataProblem);
  if (audit.audit === "checking" || execution === "running") return { verdict: "inProgress" };
  if (audit.audit === "drifted" || audit.audit === "undecided" || execution === "failed") {
    return { verdict: "needsRepair" };
  }
  if (execution === "neverRun") return { verdict: "rerunNeeded" };

  const lastRun = coords.lastRun!;
  if (lastRun.deployedShaAmbiguous) return unanswerable("ambiguousDeployedSha");
  if (!lastRun.deployedSha) return unanswerable("unknownDeployedSha");
  const since = freshness(lastRun.deployedSha, key, range);
  if (since.kind === "unanswerable") return unanswerable(since.reason);
  if (since.kind === "current") return { verdict: "verified" };
  return {
    verdict: "rerunNeeded",
    ...(since.touchedBy ? { touchedBy: since.touchedBy } : {}),
    touchedByDeploy: since.touchedByDeploy,
  };
}

interface Coords {
  lastRun: SpecLedgerEntry | null;
  lastGreen: SpecLedgerEntry | null;
  lastRed: SpecLedgerEntry | null;
}

function unanswerable(reason: RerunUnknownReason): { verdict: "unanswerable"; reason: RerunUnknownReason } {
  return { verdict: "unanswerable", reason };
}
