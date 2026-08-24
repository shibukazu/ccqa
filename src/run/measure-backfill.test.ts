import { describe, expect, it } from "vitest";

import { chooseMeasureBackfill, REMEASURE_AFTER_MS } from "./measure-backfill.ts";
import type { CoverageEdges } from "../select/coverage-edges.ts";
import type { SpecRef } from "../store/index.ts";

const ref = (name: string): SpecRef => ({ featureName: "f", specName: name });
const NOW = 1_000_000_000_000;

function edges(entries: Record<string, number>): CoverageEdges {
  return new Map(
    Object.entries(entries).map(([key, measuredAt]) => [
      `f/${key}`,
      { files: new Set(["src/a.ts"]), measuredAt },
    ]),
  );
}

describe("chooseMeasureBackfill", () => {
  it("takes unmeasured specs first, then the oldest aging ones, capped", () => {
    const inventory = [ref("fresh"), ref("old"), ref("older"), ref("never"), ref("never2")];
    const picked = chooseMeasureBackfill(
      inventory,
      [],
      edges({
        fresh: NOW - 1000,
        old: NOW - REMEASURE_AFTER_MS - 1000,
        older: NOW - REMEASURE_AFTER_MS - 5000,
      }),
      3,
      NOW,
    );
    // Unmeasured cost an `unknown` verdict today; they outrank merely aging.
    expect(picked.specs.map((s) => s.specName)).toEqual(["never", "never2", "older"]);
    expect(picked).toMatchObject({ missing: 2, aging: 1 });
  });

  it("never doubles a spec the run already selected, and skips fresh ones", () => {
    const inventory = [ref("due"), ref("fresh"), ref("never")];
    const picked = chooseMeasureBackfill(inventory, [ref("due")], edges({ fresh: NOW }), 5, NOW);
    expect(picked.specs.map((s) => s.specName)).toEqual(["never"]);
  });
});
