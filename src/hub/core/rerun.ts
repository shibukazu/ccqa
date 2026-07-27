import type {
  DeployEntry,
  DeployLog,
  DeployRef,
  RerunUnknownReason,
  SpecLedger,
  SpecLedgerEntry,
  SpecRerun,
  SpecTouchIndex,
} from "../contract/schema.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

/**
 * "Is this spec's last result still trustworthy?" — pure set arithmetic over
 * data the hub already stores (ADR-0010). Deliberately no wall clocks: a run
 * that started before a deploy and finished after it looks up to date by
 * timestamp, so the only ordering used here is position in the deploy log.
 */
export interface RerunInput {
  /** Every spec in the project's perspectives document. */
  specs: SpecTarget[];
  /** The profile's ledger, merged across branches. */
  ledger: SpecLedger;
  log: DeployLog;
  touchIndex: SpecTouchIndex;
}

export function computeRerun(input: RerunInput): Record<string, SpecRerun> {
  const { specs, ledger, log, touchIndex } = input;
  // Nothing has ever been recorded for this profile: neither a run nor a
  // deploy. That is a different statement from "this spec has never run".
  // `green` is checked separately from `run` because a pre-ledger document
  // migrates as greens with no runs.
  const notEvaluated =
    log.entries.length === 0 &&
    Object.keys(ledger.run).length === 0 &&
    Object.keys(ledger.green).length === 0;
  // First occurrence wins: a sha deployed twice is genuinely ambiguous, and
  // the earlier position widens the range, which errs towards `needed`.
  const positionBySha = new Map<string, number>();
  log.entries.forEach((entry, i) => {
    if (!positionBySha.has(entry.sha)) positionBySha.set(entry.sha, i);
  });
  // Built once instead of re-scanned per spec: `entryByIndex` backs the
  // `needed.index` lookup below, and `gapFromPos`/`noSelectionFromPos` are
  // suffix flags ("does any entry from this position onward have a gap / lack
  // a selection") so `verdict`'s range check is an array read instead of a
  // slice+scan. Specs mostly share one baseline deploy, so this turns what
  // was O(specs × log length) into O(log length).
  const entryByIndex = new Map(log.entries.map((e) => [e.index, e]));
  const gapFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  const noSelectionFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  for (let i = log.entries.length - 1; i >= 0; i--) {
    gapFromPos[i] = gapFromPos[i + 1]! || log.entries[i]!.gapBefore;
    noSelectionFromPos[i] = noSelectionFromPos[i + 1]! || !log.entries[i]!.hasSelection;
  }
  const range: RangeLookup = { entryByIndex, gapFromPos, noSelectionFromPos };

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    out[spec.key] = notEvaluated
      ? { state: "notEvaluated", ...coords }
      : { ...verdict(spec, coords.lastRun, log, positionBySha, touchIndex, range), ...coords };
  }
  return out;
}

/** Per-`computeRerun`-call lookups built once from the deploy log, not per spec. */
interface RangeLookup {
  entryByIndex: ReadonlyMap<number, DeployEntry>;
  gapFromPos: readonly boolean[];
  noSelectionFromPos: readonly boolean[];
}

type Verdict =
  | { state: "needed"; touchedBy?: string[]; touchedByDeploy: DeployRef | null }
  | { state: "notNeeded" }
  | { state: "neverRun" }
  | { state: "unknown"; reason: RerunUnknownReason };

function verdict(
  spec: SpecTarget,
  lastRun: SpecLedgerEntry | null,
  log: DeployLog,
  positionBySha: ReadonlyMap<string, number>,
  touchIndex: SpecTouchIndex,
  range: RangeLookup,
): Verdict {
  if (!lastRun) return { state: "neverRun" };
  if (log.entries.length === 0) return unknown("noDeployLog");
  if (lastRun.deployedShaAmbiguous) return unknown("ambiguousDeployedSha");
  const deployedSha = lastRun.deployedSha ?? null;
  if (!deployedSha) return unknown("unknownDeployedSha");

  const baselinePos = positionBySha.get(deployedSha);
  if (baselinePos === undefined) return unknown("deployedShaNotInLog");
  // `index` is the monotonic log position; `baselinePos` is where it sits in
  // the retained array. The touch index stores the former, so compare in it.
  const baselineIndex = log.entries[baselinePos]!.index;
  const touch = touchIndex[spec.key];

  // A positive `needed` in range settles it, whatever else the range is
  // missing: the spec has to re-run regardless of what a hole would have said.
  const needed = touch?.needed;
  if (needed && needed.index > baselineIndex) {
    // The index proves *that* a deploy in range needed the spec, by position.
    // Naming *which* one takes the log entry itself: the log is the record of
    // what shipped and the index only derived from it, so if the two disagree
    // about what is retained, the deploy goes unnamed rather than asserted
    // from a copy the record no longer backs.
    const entry = range.entryByIndex.get(needed.index);
    return {
      state: "needed",
      ...(needed.matchedPaths.length > 0 ? { touchedBy: needed.matchedPaths } : {}),
      touchedByDeploy: entry ? deployRef(entry) : null,
    };
  }

  // Nothing needed it. Clearing the spec now claims the whole range was
  // examined, so anything in it that was not disqualifies the claim. Order
  // within the range has no meaning, so a precomputed "does the range from
  // here on contain one" flag stands in for scanning it.
  //
  // Ordered by how much of the range each defect invalidates: missing deploys
  // first, then deploys nobody judged, then a deploy that was judged and came
  // back undecided for this spec.
  if (range.gapFromPos[baselinePos + 1]) return unknown("gapInRange");
  if (range.noSelectionFromPos[baselinePos + 1]) return unknown("noSelectionInRange");
  if (touch?.undecidedIndex !== undefined && touch.undecidedIndex > baselineIndex) {
    return unknown("selectionUnknown");
  }
  return { state: "notNeeded" };
}

function deployRef(entry: DeployEntry): DeployRef {
  return { index: entry.index, sha: entry.sha, at: entry.at };
}

function unknown(reason: RerunUnknownReason): Verdict {
  return { state: "unknown", reason };
}
