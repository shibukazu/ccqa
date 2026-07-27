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

const STATE_START = "// --- pure: drift row/run state";
const STATE_END = "// --- end pure: drift row/run state";

function rowStates(): {
  driftRowState: (r: { status: string; analysis: { label: string } | null }) => string;
  driftRunState: (run: { status: string; drift: unknown }) => string;
} {
  const src = clientScript();
  const start = src.indexOf(STATE_START);
  const end = src.indexOf(STATE_END);
  expect(start, "the pure drift row/run state region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { driftRowState: driftRowState, driftRunState: driftRunState };`,
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

  test("segments draw fix-first: found, unknown, notAudited, then clean", () => {
    const { driftComposition, driftSegments } = composition();
    const counts = driftComposition([{ label: "TEST_DRIFT" }, { label: "UNKNOWN" }, null, { label: null }]);
    expect(counts).toMatchObject({ found: 1, unknown: 1, notAudited: 1, clean: 1 });
    expect(driftSegments(counts).map((s) => s.state)).toEqual(["found", "unknown", "notAudited", "clean"]);
  });

  test("a row's badge follows its diagnosis, not the build-threshold status", () => {
    // UNKNOWN is below --severity on purpose: an audit that could not tell must
    // not break CI by itself. So the row "passes" while carrying a diagnosis —
    // and a badge read off status alone printed "no drift" right above it.
    const { driftRowState } = rowStates();
    expect(driftRowState({ status: "passed", analysis: { label: "UNKNOWN" } })).toBe("unknown");
    expect(driftRowState({ status: "failed", analysis: { label: "TEST_DRIFT" } })).toBe("found");
    expect(driftRowState({ status: "passed", analysis: null })).toBe("clean");
  });

  test("only a clean audit gets a green rail", () => {
    // Green tells a reader to move on. A finding has not earned that, and
    // neither has an audit that could not tell — the two share the amber rail.
    const rails = { found: "drift-found", unknown: "drift-found", clean: "passed" };
    const rule = (c: string, v: string) => new RegExp(`\\.spec-card\\.${c}[^{}]*\\{[^}]*var\\(--${v}\\)`);
    expect(HTML).toMatch(rule(rails.clean, "pass"));
    expect(rails.unknown).not.toBe(rails.clean);
    expect(HTML).toMatch(rule(rails.found, "amber"));
    expect(HTML).not.toMatch(rule(rails.found, "pass"));
  });

  test("a run's badge follows its label counts, and only falls back to status", () => {
    const { driftRunState } = rowStates();
    const run = (drift: unknown, status = "passed") => ({ status, drift });
    expect(driftRunState(run({ specs: 3, testDrift: 0, specChange: 0, unknown: 2 }))).toBe("unknown");
    expect(driftRunState(run({ specs: 3, testDrift: 1, specChange: 0, unknown: 2 }))).toBe("found");
    expect(driftRunState(run({ specs: 3, testDrift: 0, specChange: 0, unknown: 0 }))).toBe("clean");
    // A run from a hub that predates the summary has only its status to go on.
    expect(driftRunState(run(null, "failed"))).toBe("found");
  });

  test("an UNKNOWN audit is neither drift found nor clean", () => {
    const { driftComposition, driftSegments } = composition();
    // The audit saying "I could not tell" is the one answer that must not be
    // rounded: counted as found it asserts a mismatch nobody established,
    // counted as clean it hides one. It gets the same blue as re-run's unknown.
    const counts = driftComposition([{ label: "UNKNOWN" }, { label: "UNKNOWN" }]);
    expect(counts).toMatchObject({ unknown: 2, found: 0, clean: 0, notAudited: 0 });
    const cls = Object.fromEntries(driftSegments(counts).map((s) => [s.state, s.cls]));
    const rule = (c: string, v: string) => new RegExp(`\\.${c}[^{}]*\\{[^}]*var\\(--${v}\\)`);
    expect(HTML).toMatch(rule(cls.unknown!, "info"));
    expect(HTML).not.toMatch(rule(cls.unknown!, "pass"));
  });
});
