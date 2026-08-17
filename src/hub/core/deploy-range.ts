import type {
  DeployEntry,
  DeployLog,
  DeployRef,
  RerunUnknownReason,
  SpecTouchIndex,
} from "../contract/schema.ts";

/**
 * "Has any deploy since <commit> reached this spec?" — asked by the re-run
 * verdict from the deploy its last run exercised, and by the audit from the
 * commit it read.
 *
 * Deliberately no wall clocks: a run that started before a deploy and finished
 * after it looks up to date by timestamp, so the only ordering used is
 * position in the deploy log (ADR-0010).
 */
export type Freshness =
  | { kind: "current" }
  | { kind: "touched"; touchedBy?: string[]; touchedByDeploy: DeployRef | null }
  | { kind: "unanswerable"; reason: RerunUnknownReason };

/** Lookups built once per report, not per spec. */
export interface RangeLookup {
  entryByIndex: ReadonlyMap<number, DeployEntry>;
  gapFromPos: readonly boolean[];
  noSelectionFromPos: readonly boolean[];
  log: DeployLog;
  positionBySha: ReadonlyMap<string, number>;
  touchIndex: SpecTouchIndex;
}

export function buildRange(log: DeployLog, touchIndex: SpecTouchIndex): RangeLookup {
  // First occurrence wins: a sha deployed twice is genuinely ambiguous, and
  // the earlier position widens the range, which errs towards doing the work.
  const positionBySha = new Map<string, number>();
  log.entries.forEach((entry, i) => {
    if (!positionBySha.has(entry.sha)) positionBySha.set(entry.sha, i);
  });
  // `entryByIndex` backs the `touchedByDeploy` lookup; `gapFromPos` and
  // `noSelectionFromPos` are suffix flags ("does any entry from this position
  // onward have a gap / lack a selection") so the range check is an array read
  // instead of a slice+scan. Specs mostly share one baseline deploy, so this
  // turns what was O(specs × log length) into O(log length).
  const entryByIndex = new Map(log.entries.map((e) => [e.index, e]));
  const gapFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  const noSelectionFromPos: boolean[] = new Array(log.entries.length + 1).fill(false);
  for (let i = log.entries.length - 1; i >= 0; i--) {
    gapFromPos[i] = gapFromPos[i + 1]! || log.entries[i]!.gapBefore;
    noSelectionFromPos[i] = noSelectionFromPos[i + 1]! || !log.entries[i]!.hasSelection;
  }
  return { entryByIndex, gapFromPos, noSelectionFromPos, log, positionBySha, touchIndex };
}

export function freshness(baselineSha: string, key: string, range: RangeLookup): Freshness {
  const { log, positionBySha, touchIndex } = range;
  if (log.entries.length === 0) return unanswerable("noDeployLog");
  const baselinePos = positionBySha.get(baselineSha);
  if (baselinePos === undefined) return unanswerable("deployedShaNotInLog");
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
  // first, then deploys nobody judged. A deploy the selector judged and left
  // `unknown` for this spec is *not* a defect: an undecided judgment counts
  // as not reached (ADR-0023). Counting it as reached let one wide deploy
  // invalidate every spec at once, and the cycle spent more re-verifying
  // green specs than the missed-reach risk was worth.
  if (range.gapFromPos[baselinePos + 1]) return unanswerable("gapInRange");
  if (range.noSelectionFromPos[baselinePos + 1]) return unanswerable("noSelectionInRange");
  return { kind: "current" };
}

export function deployRef(entry: DeployEntry): DeployRef {
  return { index: entry.index, sha: entry.sha, at: entry.at };
}

function unanswerable(reason: RerunUnknownReason): Freshness {
  return { kind: "unanswerable", reason };
}
