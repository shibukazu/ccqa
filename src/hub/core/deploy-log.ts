import type {
  DeployEntry,
  DeployInput,
  DeployLog,
  DeploySelection,
  SpecTouchIndex,
} from "../contract/schema.ts";

/**
 * Pure deploy-log arithmetic: appending an entry, and folding it into the
 * derived per-spec touch index. Kept out of the storage layer so the rules
 * that are easy to get wrong — chaining, eviction, truncation — are testable
 * without touching a filesystem.
 */

/** How many deploys the log retains in full. Older ones are evicted, leaving a gap behind. */
export const MAX_RETAINED_DEPLOYS = 200;

/**
 * How many changed paths one entry retains. A monorepo-wide refactor can list
 * tens of thousands; `changedPaths` is record-only (re-run verdicts never
 * read it), so past this bound the entry simply keeps a prefix rather than
 * paying to store the rest.
 */
export const MAX_RETAINED_CHANGED_PATHS = 500;

/** How many matched paths a `touchedBy` sample carries, so the view can say why. */
export const MAX_TOUCHED_BY = 10;

export function emptyDeployLog(): DeployLog {
  return { nextIndex: 0, entries: [] };
}

/** Append `input` to `current`; the appended entry is always the last of `entries`. */
export function appendDeploy(current: DeployLog | null, input: DeployInput): DeployLog {
  const log = current ?? emptyDeployLog();
  const head = log.entries[log.entries.length - 1];
  // A deploy that doesn't chain onto the head means deploys are missing before
  // it, so any baseline behind it is unplaceable. Nothing can precede the very
  // first recorded deploy, so that one is not a gap; an empty log with a
  // non-zero `nextIndex` means eviction emptied it, which is.
  const gapBefore = head ? head.sha !== input.previousSha : log.nextIndex > 0;
  const entries = [
    ...log.entries,
    {
      ...input,
      index: log.nextIndex,
      changedPaths: input.changedPaths === null ? null : input.changedPaths.slice(0, MAX_RETAINED_CHANGED_PATHS),
      gapBefore,
    },
  ];
  // Ring buffer. Evicting the oldest entries destroys the history before the
  // new oldest one, so it inherits a synthetic gap.
  if (entries.length > MAX_RETAINED_DEPLOYS) {
    entries.splice(0, entries.length - MAX_RETAINED_DEPLOYS);
    entries[0] = { ...entries[0]!, gapBefore: true };
  }
  return { nextIndex: log.nextIndex + 1, entries };
}

/**
 * Fold one deploy's selection into the touch index.
 *
 * Only `needed` moves a position a verdict reads. An `unknown` records the
 * newest undecided position too, but that one is record-only (ADR-0023) —
 * freshness reads an undecided judgment as "did not reach". A `notNeeded`
 * writes neither — it is the absence of a marker at this position, which is
 * exactly what a later baseline comparison reads it as.
 *
 * Positions only ever advance. Deploys are folded in log order, so a spec
 * needed at #7 and cleared at #9 keeps `needed.index: 7`: a baseline at #5
 * must still see that #7 touched it.
 */
export function foldTouchIndex(
  current: SpecTouchIndex,
  entry: DeployEntry,
  selection: DeploySelection,
): SpecTouchIndex {
  const out = { ...current };
  for (const [key, decision] of Object.entries(selection)) {
    const previous = out[key] ?? {};
    if (decision.verdict === "needed") {
      out[key] = {
        ...previous,
        needed: {
          index: entry.index,
          sha: entry.sha,
          at: entry.at,
          matchedPaths: (decision.touchedBy ?? []).slice(0, MAX_TOUCHED_BY),
        },
      };
    } else if (decision.verdict === "unknown") {
      // An undecided deploy records only that this position is unresolved; it
      // must not disturb an earlier real touch, which a baseline behind both
      // still has to see.
      out[key] = { ...previous, undecidedIndex: entry.index };
    }
    // `notNeeded` writes neither position — see the function doc.
  }
  return out;
}
