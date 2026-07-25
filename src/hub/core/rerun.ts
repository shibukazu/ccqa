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
import { matchPaths } from "./deploy-log.ts";
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

  const out: Record<string, SpecRerun> = {};
  for (const spec of specs) {
    const coords = {
      lastRun: ledger.run[spec.key] ?? null,
      lastGreen: ledger.green[spec.key] ?? null,
      lastRed: ledger.red[spec.key] ?? null,
    };
    out[spec.key] = notEvaluated
      ? { state: "notEvaluated", ...coords }
      : { ...verdict(spec, coords.lastRun, log, positionBySha, touchIndex), ...coords };
  }
  return out;
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
): Verdict {
  if (!lastRun) return { state: "neverRun" };
  if (spec.relatedPaths.length === 0) return unknown("noRelatedPaths");
  if (log.entries.length === 0) return unknown("noDeployLog");
  if (lastRun.deployedShaAmbiguous) return unknown("ambiguousDeployedSha");
  const deployedSha = lastRun.deployedSha ?? null;
  if (!deployedSha) return unknown("unknownDeployedSha");

  const baselinePos = positionBySha.get(deployedSha);
  if (baselinePos === undefined) return unknown("deployedShaNotInLog");
  // `index` is the monotonic log position; `baselinePos` is where it sits in
  // the retained array. The touch index stores the former, so compare in it.
  const baselineIndex = log.entries[baselinePos]!.index;

  // Newest first, so the reported `touchedBy` and `touchedByDeploy` come from
  // the most recent deploy in range that touched the spec. Scanning only
  // `i > baselinePos` is what keeps that deploy in range: an older touch, even
  // the newest one the touch index knows of, is not what made this verdict.
  let sawGap = false;
  let sawUnknownContents = false;
  for (let i = log.entries.length - 1; i > baselinePos; i--) {
    const entry = log.entries[i]!;
    if (entry.changedPaths !== null && !entry.truncated) {
      const matched = matchPaths(entry.changedPaths, spec.relatedPaths);
      if (matched.length > 0) return { state: "needed", touchedBy: matched, touchedByDeploy: deployRef(entry) };
    } else {
      sawUnknownContents = true;
    }
    if (entry.gapBefore) sawGap = true;
  }
  if (!sawGap && !sawUnknownContents) return { state: "notNeeded" };

  // Part of the range can't be matched against the spec's current
  // `relatedPaths`. The write-time fold saw those deploys' full path lists, so
  // it can still prove a touch — against the `relatedPaths` of the day, which
  // is why it is consulted only here and never in place of matching the
  // spec's current paths.
  const touch = touchIndex[spec.key];
  if (touch && touch.lastTouchedIndex > baselineIndex) {
    // The index proves *that* a deploy in range touched the spec, by position.
    // Naming *which* one takes the log entry itself: the log is the record of
    // what shipped and the index only a derived accelerator, so if the two
    // disagree about what is retained, the deploy goes unnamed rather than
    // asserted from a cache the record no longer backs.
    const entry = log.entries.find((e) => e.index === touch.lastTouchedIndex);
    return {
      state: "needed",
      ...(touch.matchedPaths.length > 0 ? { touchedBy: touch.matchedPaths } : {}),
      touchedByDeploy: entry ? deployRef(entry) : null,
    };
  }
  return unknown(sawGap ? "gapInRange" : "truncatedInRange");
}

function deployRef(entry: DeployEntry): DeployRef {
  return { index: entry.index, sha: entry.sha, at: entry.at };
}

function unknown(reason: RerunUnknownReason): Verdict {
  return { state: "unknown", reason };
}
