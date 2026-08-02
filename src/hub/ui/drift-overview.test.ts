import { describe, expect, test } from "vitest";
import { renderHubUi } from "./index.ts";

/**
 * The Run Detail page's per-spec-card and per-run drift badges (a pushed
 * kind:"drift" run's results). Lifted out and run the same way
 * rerun-view.test.ts exercises its pure regions — self-contained (no DOM, no
 * closures) so the badge/rail mapping can be asserted without a browser.
 *
 * The Perspectives overview's own drift-ledger composition (driftComposition/
 * driftSegments) was retired with the fourth "drift audit" column: the audit
 * axis in the /rerun report (rr.audit, ADR-0014) is the fresher, deploy-aware
 * answer to the same question, so Perspectives' summary bars are covered by
 * rerun-view.test.ts instead.
 */

const HTML = renderHubUi();

function clientScript(): string {
  const open = HTML.indexOf("<script>");
  const close = HTML.lastIndexOf("</script>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return HTML.slice(open + "<script>".length, close);
}

const STATE_START = "// --- pure: drift row/run state";
const STATE_END = "// --- end pure: drift row/run state";

function rowStates(): {
  driftRowState: (r: { status: string; analysis: { label: string } | null }) => string;
  driftRunState: (run: { status: string; drift: unknown }) => string;
  answersDrift: (run: { kind: string; status: string }) => boolean;
} {
  const src = clientScript();
  const start = src.indexOf(STATE_START);
  const end = src.indexOf(STATE_END);
  expect(start, "the pure drift row/run state region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { driftRowState: driftRowState, driftRunState: driftRunState, answersDrift: answersDrift };`,
  )();
}

describe("hub UI: run detail drift badges", () => {
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

  test("an audit still running is not asked what it found", () => {
    // Its summary is absent because it has not finished, and `driftRunState`
    // reads an absent summary as "clean" — so an audit mid-sweep would claim
    // "no drift" while it was still looking.
    const { answersDrift } = rowStates();
    expect(answersDrift({ kind: "drift", status: "running" })).toBe(false);
    expect(answersDrift({ kind: "drift", status: "passed" })).toBe(true);
    expect(answersDrift({ kind: "run", status: "passed" })).toBe(false);
  });
});
