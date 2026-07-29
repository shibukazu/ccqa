import type {
  AuditState,
  DeployEntry,
  DeployLog,
  DeployRef,
  DriftLedger,
  ExecutionState,
  RerunUnknownReason,
  SpecLedger,
  SpecLedgerEntry,
  SpecRerun,
  SpecTouchIndex,
} from "../contract/schema.ts";
import type { DriftLabel } from "../../report/schema.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "What should happen to this spec next?" — pure set arithmetic over data the
 * hub already stores (ADR-0010). Deliberately no wall clocks: a run that
 * started before a deploy and finished after it looks up to date by timestamp,
 * so the only ordering used here is position in the deploy log.
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
  // First occurrence wins: a sha deployed twice is genuinely ambiguous, and
  // the earlier position widens the range, which errs towards a re-run.
  const positionBySha = new Map<string, number>();
  log.entries.forEach((entry, i) => {
    if (!positionBySha.has(entry.sha)) positionBySha.set(entry.sha, i);
  });
  // Built once instead of re-scanned per spec: `entryByIndex` backs the
  // `touchedByDeploy` lookup below, and `gapFromPos`/`noSelectionFromPos` are
  // suffix flags ("does any entry from this position onward have a gap / lack
  // a selection") so the range check is an array read instead of a slice+scan.
  // Specs mostly share one baseline deploy, so this turns what was
  // O(specs × log length) into O(log length).
  const entryByIndex = new Map(log.entries.map((e) => [e.index, e]));
  const gapFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  const noSelectionFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  for (let i = log.entries.length - 1; i >= 0; i--) {
    gapFromPos[i] = gapFromPos[i + 1]! || log.entries[i]!.gapBefore;
    noSelectionFromPos[i] = noSelectionFromPos[i + 1]! || !log.entries[i]!.hasSelection;
  }
  const range: RangeLookup = { entryByIndex, gapFromPos, noSelectionFromPos, log, positionBySha, touchIndex };

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
function auditState(
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

/** Per-`computeRerun`-call lookups built once from the deploy log, not per spec. */
interface RangeLookup {
  entryByIndex: ReadonlyMap<number, DeployEntry>;
  gapFromPos: readonly boolean[];
  noSelectionFromPos: readonly boolean[];
  log: DeployLog;
  positionBySha: ReadonlyMap<string, number>;
  touchIndex: SpecTouchIndex;
}

type Freshness =
  | { kind: "current" }
  | { kind: "touched"; touchedBy?: string[]; touchedByDeploy: DeployRef | null }
  | { kind: "unanswerable"; reason: RerunUnknownReason };

/**
 * Has any deploy since `baselineSha` reached this spec?
 *
 * Both axes ask this, differing only in where the baseline comes from: the
 * commit the audit read, or the deploy the last run exercised. Sharing it is
 * what keeps "does the audit still apply" and "does the result still apply"
 * from drifting apart as two near-copies of the same range arithmetic.
 */
function freshness(baselineSha: string, key: string, range: RangeLookup): Freshness {
  const { log, positionBySha, touchIndex } = range;
  if (log.entries.length === 0) return unanswerableFreshness("noDeployLog");
  const baselinePos = positionBySha.get(baselineSha);
  if (baselinePos === undefined) return unanswerableFreshness("deployedShaNotInLog");
  // `index` is the monotonic log position; `baselinePos` is where it sits in
  // the retained array. The touch index stores the former, so compare in it.
  const baselineIndex = log.entries[baselinePos]!.index;
  const touch = touchIndex[key];

  // A positive touch in range settles it, whatever else the range is missing:
  // the spec is out of date regardless of what a hole would have said.
  const touched = touch?.needed;
  if (touched && touched.index > baselineIndex) {
    // The index proves *that* a deploy in range reached the spec, by position.
    // Naming *which* one takes the log entry itself: the log is the record of
    // what shipped and the index only derived from it, so if the two disagree
    // about what is retained, the deploy goes unnamed rather than asserted
    // from a copy the record no longer backs.
    const entry = range.entryByIndex.get(touched.index);
    return {
      kind: "touched",
      ...(touched.matchedPaths.length > 0 ? { touchedBy: touched.matchedPaths } : {}),
      touchedByDeploy: entry ? deployRef(entry) : null,
    };
  }

  // Nothing reached it. Clearing the spec now claims the whole range was
  // examined, so anything in it that was not disqualifies the claim. Order
  // within the range has no meaning, so a precomputed "does the range from
  // here on contain one" flag stands in for scanning it.
  //
  // Ordered by how much of the range each defect invalidates: missing deploys
  // first, then deploys nobody judged, then a deploy that was judged and came
  // back undecided for this spec.
  if (range.gapFromPos[baselinePos + 1]) return unanswerableFreshness("gapInRange");
  if (range.noSelectionFromPos[baselinePos + 1]) return unanswerableFreshness("noSelectionInRange");
  if (touch?.undecidedIndex !== undefined && touch.undecidedIndex > baselineIndex) {
    return unanswerableFreshness("selectionUnknown");
  }
  return { kind: "current" };
}

function deployRef(entry: DeployEntry): DeployRef {
  return { index: entry.index, sha: entry.sha, at: entry.at };
}

function unanswerable(reason: RerunUnknownReason): { verdict: "unanswerable"; reason: RerunUnknownReason } {
  return { verdict: "unanswerable", reason };
}

function unanswerableFreshness(reason: RerunUnknownReason): Freshness {
  return { kind: "unanswerable", reason };
}
