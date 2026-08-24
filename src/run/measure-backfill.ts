import type { CoverageEdges } from "../select/coverage-edges.ts";
import { EDGE_MAX_AGE_MS } from "../select/coverage-edges.ts";
import { specKey, type SpecRef } from "../store/index.ts";

/**
 * `ccqa run --measure-backfill <n>`: keep the measured-reach edges alive.
 *
 * Selection (ADR-0024) consumes each spec's most recent measured reach, and
 * an edge expires after `EDGE_MAX_AGE_MS`. Nothing else re-measures: an
 * unmeasured spec answers `unknown`, `unknown` marks nothing due (ADR-0023),
 * and a suite can settle into a state where no run ever fires — the seed
 * deadlock. Appending a few unmeasured-or-aging specs to every selected run
 * breaks that loop and keeps the whole suite inside the freshness window
 * without a scheduled full sweep.
 */

/**
 * Re-measure once an edge has spent half its lifetime. Half, not "expired":
 * a spec re-measured only after expiry answers `unknown` for the gap between
 * expiry and the next run, which is exactly the window this flag exists to
 * close.
 */
export const REMEASURE_AFTER_MS = EDGE_MAX_AGE_MS / 2;

export interface BackfillPick {
  specs: SpecRef[];
  missing: number;
  aging: number;
}

/**
 * Picks up to `limit` specs from `inventory` worth re-measuring: ones with no
 * edge at all first (they cost an `unknown` verdict today), then the oldest
 * measured ones. Specs already selected for this run are never doubled.
 */
export function chooseMeasureBackfill(
  inventory: readonly SpecRef[],
  selected: readonly SpecRef[],
  edges: CoverageEdges,
  limit: number,
  now: number,
): BackfillPick {
  const alreadyRunning = new Set(selected.map(specKey));
  const missing: SpecRef[] = [];
  const aging: Array<{ spec: SpecRef; measuredAt: number }> = [];
  for (const spec of inventory) {
    if (alreadyRunning.has(specKey(spec))) continue;
    const edge = edges.get(specKey(spec));
    if (edge === undefined) {
      missing.push(spec);
    } else if (now - edge.measuredAt > REMEASURE_AFTER_MS) {
      aging.push({ spec, measuredAt: edge.measuredAt });
    }
  }
  aging.sort((a, b) => a.measuredAt - b.measuredAt);
  const specs = [...missing, ...aging.map((entry) => entry.spec)].slice(0, limit);
  const missingTaken = Math.min(missing.length, specs.length);
  return { specs, missing: missingTaken, aging: specs.length - missingTaken };
}
