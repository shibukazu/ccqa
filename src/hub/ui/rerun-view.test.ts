import { describe, expect, test } from "vitest";
import { RerunStateSchema, RerunUnknownReasonSchema } from "../contract/schema.ts";
import { renderHubUi } from "./index.ts";

/**
 * The Perspectives tab's "needs re-run" column (ADR-0010). The UI is one HTML
 * string with no build step and the suite has no DOM, so these assert over the
 * rendered page: that the client script still parses, that every state and
 * reason the hub can send has wording, and — the part that matters most — that
 * the vocabulary stays separated from drift's. "Needs re-run" (mechanical) and
 * freshness/drift (semantic) are different questions, and the ADR reserves the
 * words accordingly.
 */

const HTML = renderHubUi();

function clientScript(): string {
  const open = HTML.indexOf("<script>");
  const close = HTML.lastIndexOf("</script>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return HTML.slice(open + "<script>".length, close);
}

/**
 * The summary bar's bucketing logic, lifted out of the rendered page and run.
 * The client script is one IIFE that touches the DOM on load and this suite has
 * no browser, so the region between these markers is written self-contained
 * (no DOM, no closures) precisely so it can be exercised here — it is where an
 * overstatement ("all clear" on a profile nobody evaluated) would do the most
 * damage.
 */
const PURE_START = "// --- pure: rerun composition";
const PURE_END = "// --- end pure: rerun composition";

interface Segment {
  state: string;
  count: number;
  cls: string;
}

function composition(): {
  RERUN_ORDER: string[];
  rerunComposition: (verdicts: ({ state?: string } | null)[]) => Record<string, number>;
  rerunSegments: (counts: Record<string, number>) => Segment[];
} {
  const src = clientScript();
  const start = src.indexOf(PURE_START);
  const end = src.indexOf(PURE_END);
  expect(start, "the pure re-run composition region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { RERUN_ORDER: RERUN_ORDER, rerunComposition: rerunComposition, rerunSegments: rerunSegments };`,
  )();
}

/**
 * The expanded panel's row structure, lifted the same way. The builder itself
 * touches the DOM, so the decisions worth pinning — which label the evidence
 * row wears, which deploy that row names, and whether there is a failure row at
 * all — are written self-contained between these markers.
 */
const DETAIL_START = "// --- pure: rerun detail labels";
const DETAIL_END = "// --- end pure: rerun detail labels";

interface ChangeLine {
  key: string;
  sha: string | null;
  at: string | null;
}

function detailLabels(): {
  rerunEvidenceLabelKey: (state: string) => string;
  rerunHasFailure: (rr: { lastRed?: unknown } | null) => boolean;
  rerunChangeLine: (
    rr: { state: string; touchedByDeploy?: { sha: string; at: string } | null },
    deployHead: { sha: string; at: string } | null,
  ) => ChangeLine;
} {
  const src = clientScript();
  const start = src.indexOf(DETAIL_START);
  const end = src.indexOf(DETAIL_END);
  expect(start, "the pure re-run detail-label region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { rerunEvidenceLabelKey: rerunEvidenceLabelKey, rerunHasFailure: rerunHasFailure, rerunChangeLine: rerunChangeLine };`,
  )();
}

/** The `en`/`ja` literals out of the rendered page, as real objects. */
function dictionaries(): { en: Record<string, string>; ja: Record<string, string> } {
  const enStart = HTML.indexOf("en: {");
  const jaStart = HTML.indexOf("ja: {", enStart);
  const jaEnd = HTML.indexOf("};", jaStart);
  expect(enStart).toBeGreaterThan(-1);
  expect(jaStart).toBeGreaterThan(enStart);
  const en = HTML.slice(enStart + "en: ".length, jaStart).trim().replace(/,$/, "");
  const ja = HTML.slice(jaStart + "ja: ".length, jaEnd).trim();
  return { en: JSON.parse(en), ja: JSON.parse(ja) };
}

describe("hub UI: needs re-run", () => {
  test("the client script parses (no stray backtick in a comment)", () => {
    // Compiled, never called: a backtick inside a CLIENT_JS comment silently
    // terminates the enclosing template literal and only shows up in a browser.
    expect(() => new Function(clientScript())).not.toThrow();
  });

  test("every state and unknown-reason the hub can send has wording", () => {
    const { en, ja } = dictionaries();
    for (const state of RerunStateSchema.options) {
      for (const dict of [en, ja]) expect(dict[`perspectives.rerun.state.${state}`]).toBeTruthy();
    }
    for (const reason of RerunUnknownReasonSchema.options) {
      for (const dict of [en, ja]) {
        // Short form for the table cell, actionable form for the detail row.
        expect(dict[`perspectives.rerun.why.${reason}`]).toBeTruthy();
        expect(dict[`perspectives.rerun.fix.${reason}`]).toBeTruthy();
      }
    }
  });

  test("unknown never reads like notNeeded, and uses the ADR's Japanese words", () => {
    const { en, ja } = dictionaries();
    expect(ja["perspectives.rerun.state.needed"]).toBe("要再実行");
    expect(ja["perspectives.rerun.state.notNeeded"]).toBe("不要");
    expect(ja["perspectives.rerun.state.unknown"]).toBe("不明");
    expect(ja["perspectives.rerun.state.neverRun"]).toBe("未実行");
    for (const dict of [en, ja]) {
      expect(dict["perspectives.rerun.state.unknown"]).not.toBe(dict["perspectives.rerun.state.notNeeded"]);
    }
  });

  test("notNeeded names what it was judged against, and noDeployLog is actionable", () => {
    const { en, ja } = dictionaries();
    // A bare "up to date" would hide the baseline the verdict rests on.
    expect(en["perspectives.rerun.vsDeploy"]).toMatch(/deploy/i);
    expect(ja["perspectives.rerun.vsDeploy"]).toContain("デプロイ");
    // The one state a user can fix directly must say how.
    for (const dict of [en, ja]) {
      expect(dict["perspectives.rerun.fix.noDeployLog"]).toContain("ccqa hub deploy record");
      expect(dict["perspectives.rerun.noDeployLogBanner"]).toContain("ccqa hub deploy record");
      expect(dict["perspectives.rerun.noDeployLogBanner"]).toContain("{profile}");
    }
  });

  test("user-facing copy never uses the freshness vocabulary drift owns", () => {
    const { en, ja } = dictionaries();
    for (const [key, value] of [...Object.entries(en), ...Object.entries(ja)]) {
      expect(`${key}=${value}`).not.toMatch(/\bstale\b/i);
      // "refresh" is fine; the reserved word is "fresh" on its own.
      expect(`${key}=${value}`.replace(/refresh/gi, "")).not.toMatch(/fresh/i);
      expect(value).not.toContain("鮮度");
    }
  });

  test("a profile with no re-run data reads as not evaluated, never as an all-clear", () => {
    const { rerunComposition, rerunSegments } = composition();
    // Three cases, no verdict for any of them: an older hub, a failed fetch, or
    // a profile nothing has been recorded on.
    const segments = rerunSegments(rerunComposition([null, null, null]));
    expect(segments.map((s) => s.state)).toEqual(["notEvaluated"]);
    expect(segments[0]!.count).toBe(3);
    // The damaging render is a zero-count "needs re-run" segment sitting next
    // to a full "not needed" one — it reads as "nothing to do here".
    for (const state of ["needed", "notNeeded"]) {
      expect(segments.some((s) => s.state === state)).toBe(false);
    }
  });

  test("unknown keeps its own segment and colour — it is never folded into notNeeded", () => {
    const { rerunComposition, rerunSegments } = composition();
    const counts = rerunComposition([{ state: "unknown" }, { state: "notNeeded" }, { state: "unknown" }]);
    expect(counts).toMatchObject({ unknown: 2, notNeeded: 1, needed: 0 });
    const cls = Object.fromEntries(rerunSegments(counts).map((s) => [s.state, s.cls]));
    expect(cls.unknown).not.toBe(cls.notNeeded);
    // And it must not be painted like a pass: notNeeded owns --pass, unknown
    // takes the info hue.
    expect(HTML).toMatch(new RegExp(`\\.${cls.unknown}\\s*\\{[^}]*var\\(--info\\)`));
    expect(HTML).not.toMatch(new RegExp(`\\.${cls.unknown}\\s*\\{[^}]*var\\(--pass\\)`));
    expect(HTML).toMatch(new RegExp(`\\.${cls.notNeeded}\\s*\\{[^}]*var\\(--pass\\)`));
  });

  test("every state the hub can send has a segment, and an unrecognised one is not an all-clear", () => {
    const { RERUN_ORDER, rerunComposition } = composition();
    for (const state of RerunStateSchema.options) expect(RERUN_ORDER).toContain(state);
    // A state a newer hub invents cannot be counted as "no action needed".
    const counts = rerunComposition([{ state: "somethingANewerHubSends" }]);
    expect(counts).toMatchObject({ unknown: 1, notNeeded: 0, notEvaluated: 0 });
  });

  test("the summary is inventory + composition; the mode counts moved to the chips", () => {
    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) {
      expect(dict["perspectives.ov.cases"]).toBeTruthy();
      expect(dict["perspectives.ov.features"]).toBeTruthy();
    }
    // The dropped tiles' keys are removed, not left dangling.
    for (const key of [
      "perspectives.metric.features",
      "perspectives.metric.cases",
      "perspectives.metric.deterministic",
      "perspectives.metric.live",
      "perspectives.cov.runnable",
      "perspectives.cov.notRecorded",
    ]) {
      expect(en[key], `${key} is unused and should be gone`).toBeUndefined();
      expect(ja[key]).toBeUndefined();
    }
    // Every filter chip has a count slot, and none carries data-i18n on the
    // button itself — applyStaticI18n's textContent swap would delete it.
    expect(HTML.match(/class="fcount"/g)).toHaveLength(5);
    expect(HTML).not.toMatch(/<button class="fchip"[^>]*data-i18n=/);
  });

  test("the evidence row is labelled by what it holds, not by one label forced over both", () => {
    const { rerunEvidenceLabelKey } = detailLabels();
    // A verdict with evidence: the row shows what the deploy log holds since the
    // last run, so the label states that timeframe.
    for (const state of ["needed", "notNeeded"]) {
      expect(rerunEvidenceLabelKey(state)).toBe("perspectives.d.changedSince");
    }
    // No evidence exists for these — the row names the missing input instead,
    // which is a different kind of content and must not wear the other label.
    for (const state of ["unknown", "neverRun", "notEvaluated"]) {
      expect(rerunEvidenceLabelKey(state)).toBe("perspectives.d.cannotJudge");
    }
    const { en, ja } = dictionaries();
    for (const key of ["perspectives.d.changedSince", "perspectives.d.cannotJudge"]) {
      expect(en[key]).toBeTruthy();
      expect(ja[key]).toBeTruthy();
    }
    // The label carries the timeframe, so the values must not repeat it.
    for (const key of ["perspectives.rerun.changesSome", "perspectives.rerun.changesNone"]) {
      expect(ja[key]).not.toContain("前回実行以降");
      expect(ja[key]).toContain("{sha}");
      expect(en[key]).toContain("{sha}");
    }
  });

  test("the evidence row names the deploy that caused the verdict when the hub reports one", () => {
    const { rerunChangeLine } = detailLabels();
    const head = { sha: "9999999999", at: "2026-07-25T00:00:00Z" };
    const line = rerunChangeLine(
      { state: "needed", touchedByDeploy: { sha: "abcdef0123", at: "2026-07-20T00:00:00Z" } },
      head,
    );
    // The cause, not the head the judgement was made at, and with the time it
    // landed — which only a named cause carries.
    expect(line).toEqual({ key: "perspectives.rerun.changedByDeploy", sha: "abcdef0123", at: "2026-07-20T00:00:00Z" });

    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) expect(dict["perspectives.rerun.changedByDeploy"]).toContain("{sha}");
  });

  test("without a named deploy the row keeps the weaker judgement-point wording", () => {
    const { rerunChangeLine } = detailLabels();
    const head = { sha: "9999999999", at: "2026-07-25T00:00:00Z" };
    // An older hub omits the field; a hub that could not confirm the entry
    // sends null. Neither may be dressed up as a cause, and neither takes a
    // timestamp — the head's time is not when the change landed.
    for (const rr of [{ state: "needed" }, { state: "needed", touchedByDeploy: null }]) {
      expect(rerunChangeLine(rr, head)).toEqual({
        key: "perspectives.rerun.changesSome",
        sha: head.sha,
        at: null,
      });
    }
    // notNeeded has no touching deploy at all, so naming the head as the
    // judgement point stays correct there.
    expect(rerunChangeLine({ state: "notNeeded" }, head)).toEqual({
      key: "perspectives.rerun.changesNone",
      sha: head.sha,
      at: null,
    });
    // A report with no deploy head contradicts both states; say that instead.
    expect(rerunChangeLine({ state: "notNeeded" }, null)).toEqual({
      key: "perspectives.rerun.noDeployHead",
      sha: null,
      at: null,
    });
  });

  test("the failure row is omitted when the case has never failed", () => {
    const { rerunHasFailure } = detailLabels();
    expect(rerunHasFailure({ lastRed: { runId: "r1", at: "2026-01-01T00:00:00Z" } })).toBe(true);
    expect(rerunHasFailure({ lastRed: null })).toBe(false);
    expect(rerunHasFailure(null)).toBe(false);
    // And the "never failed" wording it replaced is gone, not left dangling.
    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) expect(dict["perspectives.rerun.neverRed"]).toBeUndefined();
  });

  test("the panel repeats nothing the row already carries", () => {
    // The verdict badge is rendered in exactly one place — the table cell. Two
    // matches: the definition and that single call.
    expect(clientScript().match(/rerunBadge\(/g)).toHaveLength(2);
    const { en, ja } = dictionaries();
    for (const key of [
      // The verdict badge and its explanation were a second copy of the cell.
      "perspectives.d.rerun",
      // A separate deploy-changes row said what the evidence row now says once.
      "perspectives.d.touchedBy",
      "perspectives.rerun.touchedByHint",
      "perspectives.rerun.notNeededDetail",
      // Last passed is the row's own last-result column when it passed.
      "perspectives.d.lastGreen",
      "perspectives.rerun.neverGreen",
    ]) {
      expect(en[key], `${key} is unused and should be gone`).toBeUndefined();
      expect(ja[key]).toBeUndefined();
    }
  });

  test("the panel reads as the row grown taller, not as a card under it", () => {
    // Same surface as the row, and no rule between a case and its own panel.
    expect(HTML).toMatch(/tr\.detail > td \{[^}]*background: var\(--surface\);/);
    expect(HTML).toMatch(/tr\.row\[aria-expanded="true"\] > td \{[^}]*border-bottom: 0/);
    // Prose gets a measure, and paths wrap as whole chips.
    expect(HTML).toMatch(/\.d-prose \{[^}]*max-width:/);
    expect(HTML).toMatch(/\.d-paths code \{[^}]*white-space: nowrap/);
  });

  test("the re-run surface starts hidden, so an older hub degrades to the current view", () => {
    for (const id of ["persp-th-result", "persp-th-rerun", "persp-chip-rerun"]) {
      const tag = HTML.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
      expect(tag, `${id} is missing from the markup`).toBeTruthy();
      expect(tag![0]).toContain("hidden");
    }
    // Needs re-run is profile-scoped, so this tab carries its own selector.
    expect(HTML).toContain('id="persp-profile-switch"');
    expect(HTML).toContain('id="persp-profile-current"');
  });
});
