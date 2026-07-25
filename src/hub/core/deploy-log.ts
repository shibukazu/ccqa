import { isPathAffectedBy } from "../../drift/affected.ts";
import type { DeployEntry, DeployInput, DeployLog, SpecTouchIndex } from "../contract/schema.ts";
import type { SpecTarget } from "./perspectives-specs.ts";

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
 * tens of thousands; past this bound the entry keeps a prefix and is marked
 * truncated, which makes it "touches everything" for anyone reading it back.
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
  const truncated = input.changedPaths !== null && input.changedPaths.length > MAX_RETAINED_CHANGED_PATHS;
  const entries = [
    ...log.entries,
    {
      ...input,
      index: log.nextIndex,
      changedPaths: truncated ? input.changedPaths!.slice(0, MAX_RETAINED_CHANGED_PATHS) : input.changedPaths,
      truncated,
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
 * Fold one deploy into the touch index, matched against `changedPaths` as the
 * deploy job reported them — the log's retained copy may be truncated, and
 * this is the only moment the full list exists.
 *
 * A deploy that reported no paths touches every spec: fail-open, and
 * self-limiting because it makes everything re-run once and then settles.
 */
export function foldTouchIndex(
  current: SpecTouchIndex,
  entry: DeployEntry,
  changedPaths: string[] | null,
  targets: SpecTarget[],
): SpecTouchIndex {
  const out = { ...current };
  for (const target of targets) {
    // An unscoped spec is `unknown`, not touched — recording a touch for it
    // would dress that up as a definite answer.
    if (target.relatedPaths.length === 0) continue;
    const matched = changedPaths === null ? [] : matchPaths(changedPaths, target.relatedPaths);
    if (changedPaths !== null && matched.length === 0) continue;
    out[target.key] = {
      lastTouchedIndex: entry.index,
      lastTouchedSha: entry.sha,
      lastTouchedAt: entry.at,
      matchedPaths: matched,
    };
  }
  return out;
}

/**
 * The paths in `changedPaths` covered by `relatedPaths`, up to the sample
 * size. Uses `isPathAffectedBy`, the same matcher `ccqa drift --changed` and
 * `ccqa run --changed` use, so the hub's verdict and the CLI's cannot diverge.
 */
export function matchPaths(changedPaths: string[], relatedPaths: string[]): string[] {
  const out: string[] = [];
  for (const path of changedPaths) {
    if (!isPathAffectedBy(path, relatedPaths)) continue;
    out.push(path);
    if (out.length >= MAX_TOUCHED_BY) break;
  }
  return out;
}
