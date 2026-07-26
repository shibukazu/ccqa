import { describe, expect, test } from "vitest";
import { renderHubUi } from "./index.ts";

/**
 * The Perspectives overview's drift axis. Lifted out and run the same way
 * rerun-view.test.ts exercises rerunComposition/rerunSegments — this region is
 * likewise self-contained (no DOM, no closures) so the two properties that
 * matter (zero-count segments are dropped, order is fix-first) can be
 * asserted without a browser.
 */

const HTML = renderHubUi();

function clientScript(): string {
  const open = HTML.indexOf("<script>");
  const close = HTML.lastIndexOf("</script>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return HTML.slice(open + "<script>".length, close);
}

const PURE_START = "// --- pure: drift composition";
const PURE_END = "// --- end pure: drift composition";

interface Segment {
  state: string;
  count: number;
  cls: string;
}

function composition(): {
  driftComposition: (entries: ({ label: string | null } | null)[]) => Record<string, number>;
  driftSegments: (counts: Record<string, number>) => Segment[];
} {
  const src = clientScript();
  const start = src.indexOf(PURE_START);
  const end = src.indexOf(PURE_END);
  expect(start, "the pure drift composition region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { driftComposition: driftComposition, driftSegments: driftSegments };`,
  )();
}

describe("hub UI: perspectives drift overview", () => {
  test("no drift data reads as not-audited, and zero-count segments are dropped", () => {
    const { driftComposition, driftSegments } = composition();
    const segments = driftSegments(driftComposition([null, null, null]));
    expect(segments.map((s) => s.state)).toEqual(["notAudited"]);
    expect(segments[0]!.count).toBe(3);
    for (const state of ["found", "clean"]) {
      expect(segments.some((s) => s.state === state)).toBe(false);
    }
  });

  test("segments draw fix-first: found, then notAudited, then clean", () => {
    const { driftComposition, driftSegments } = composition();
    const counts = driftComposition([{ label: "TEST_DRIFT" }, null, { label: null }]);
    expect(counts).toMatchObject({ found: 1, notAudited: 1, clean: 1 });
    expect(driftSegments(counts).map((s) => s.state)).toEqual(["found", "notAudited", "clean"]);
  });
});
