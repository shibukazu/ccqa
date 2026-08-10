import { describe, expect, test } from "vitest";
import {
  AuditStateSchema,
  ExecutionStateSchema,
  RerunUnknownReasonSchema,
  SpecVerdictSchema,
} from "../contract/schema.ts";
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
  rerunVerdictOf: (rr: { verdict?: string } | null) => string;
  rerunComposition: (verdicts: ({ verdict?: string } | null)[]) => Record<string, number>;
  rerunSegments: (counts: Record<string, number>) => Segment[];
} {
  const src = clientScript();
  const start = src.indexOf(PURE_START);
  const end = src.indexOf(PURE_END);
  expect(start, "the pure re-run composition region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { RERUN_ORDER: RERUN_ORDER, rerunVerdictOf: rerunVerdictOf, rerunComposition: rerunComposition, rerunSegments: rerunSegments };`,
  )();
}

/**
 * The expanded panel's reason wording, lifted the same way. The builder itself
 * touches the DOM, so the decision worth pinning — which deploy the reason
 * line names — is written self-contained between these markers.
 */
const DETAIL_START = "// --- pure: rerun detail labels";
const DETAIL_END = "// --- end pure: rerun detail labels";

interface ChangeLine {
  key: string;
  sha: string | null;
  at: string | null;
}

function detailLabels(): {
  rerunChangeLine: (
    rr: { verdict: string; touchedByDeploy?: { sha: string; at: string } | null },
    deployHead: { sha: string; at: string } | null,
  ) => ChangeLine;
} {
  const src = clientScript();
  const start = src.indexOf(DETAIL_START);
  const end = src.indexOf(DETAIL_END);
  expect(start, "the pure re-run detail-label region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { rerunChangeLine: rerunChangeLine };`,
  )();
}

/**
 * The execution column's value mapping, lifted the same way: what the axis
 * calls a state is not what the column calls it, and a new axis value with no
 * wording would render as a raw dotted path.
 */
const RUN_STATE_START = "// --- pure: run-state labels";
const RUN_STATE_END = "// --- end pure: run-state labels";

function runStateLabels(): {
  perspRunState: (rr: { execution?: string } | null) => string | null;
  RUN_STATE_BADGE: Record<string, string>;
} {
  const src = clientScript();
  const start = src.indexOf(RUN_STATE_START);
  const end = src.indexOf(RUN_STATE_END);
  expect(start, "the pure run-state region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { perspRunState: perspRunState, RUN_STATE_BADGE: RUN_STATE_BADGE };`,
  )();
}

/**
 * Whether a spec's last audit dismissal is the one currently holding the
 * audit axis clean, or an old one a later audit re-flagged — lifted the same
 * way, since perspDetailContent's override controls branch on exactly this
 * read.
 */
const DISMISSAL_START = "// --- pure: audit dismissal reading";
const DISMISSAL_END = "// --- end pure: audit dismissal reading";

function dismissalReading(): {
  auditDismissalActive: (
    rr: { audit?: string; auditDismissed?: unknown; auditDismissalApplied?: boolean } | null,
  ) => boolean;
  auditOpen: (rr: { audit?: string } | null) => boolean;
} {
  const src = clientScript();
  const start = src.indexOf(DISMISSAL_START);
  const end = src.indexOf(DISMISSAL_END);
  expect(start, "the pure audit-dismissal-reading region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { auditDismissalActive: auditDismissalActive, auditOpen: auditOpen };`,
  )();
}

/**
 * Which profile the Perspectives tab opens into on a project's first visit,
 * lifted the same way: candidate ordering/dedup, and which candidate wins
 * once their deploy logs have been probed, are plain functions worth pinning
 * without mocking a fetch.
 */
const DATA_PROFILE_START = "// --- pure: data-profile pick";
const DATA_PROFILE_END = "// --- end pure: data-profile pick";

function dataProfilePick(): {
  pickDataProfile: (current: string, dataProfiles: string[]) => string;
  dataProfileCandidates: (current: string, dataProfiles: string[], projectProfiles: string[]) => string[];
  pickFirstWithDeployLog: (
    candidates: string[],
    hasLog: boolean[],
    current: string,
    dataProfiles: string[],
  ) => string;
} {
  const src = clientScript();
  const start = src.indexOf(DATA_PROFILE_START);
  const end = src.indexOf(DATA_PROFILE_END);
  expect(start, "the pure data-profile-pick region is missing").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(
    `${src.slice(start, end)}\nreturn { pickDataProfile: pickDataProfile, dataProfileCandidates: dataProfileCandidates, pickFirstWithDeployLog: pickFirstWithDeployLog };`,
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

  test("the client script calls no helper it does not define", () => {
    // Parsing is not enough: deleting a helper leaves the page syntactically
    // valid and throws only when a browser reaches the call. Comments and
    // string literals are stripped first so prose does not read as a call.
    const src = clientScript()
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");

    const declared = new Set([
      // Browser and language globals the script legitimately reaches for.
      "encodeURIComponent", "String", "Number", "Boolean", "Error", "Date",
      "Promise", "JSON", "Math", "Object", "Array", "fetch", "setTimeout",
      "clearTimeout", "FileReader", "parseInt", "parseFloat", "isNaN",
      // Keywords that take a parenthesised head.
      "if", "for", "while", "switch", "catch", "return", "function", "typeof",
      "new", "delete", "throw", "in", "of", "do", "else", "instanceof", "void",
    ]);
    for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1] ?? "");
    for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1] ?? "");
    for (const m of src.matchAll(/\bfunction\s*[\w$]*\s*\(([^)]*)\)/g)) {
      for (const p of (m[1] ?? "").split(",")) if (p.trim()) declared.add(p.trim());
    }

    const undefinedCallees = new Set<string>();
    for (const m of src.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2] ?? "";
      if (!declared.has(name)) undefinedCallees.add(name);
    }
    expect([...undefinedCallees]).toEqual([]);
  });

  test("every state and unknown-reason the hub can send has wording", () => {
    const { en, ja } = dictionaries();
    for (const state of SpecVerdictSchema.options) {
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

  test("every audit-axis value the hub can send has wording, in both languages", () => {
    // The axis column renders these directly; a missing key would show the raw
    // dotted path where a state name belongs.
    const { en, ja } = dictionaries();
    for (const state of AuditStateSchema.options) {
      for (const dict of [en, ja]) {
        expect(dict[`perspectives.audit.state.${state}`], state).toBeTruthy();
      }
    }
  });

  test("every execution-axis value the hub can send has a badge and wording", () => {
    const { perspRunState, RUN_STATE_BADGE } = runStateLabels();
    const { en, ja } = dictionaries();
    for (const execution of ExecutionStateSchema.options) {
      const key = perspRunState({ execution })!;
      expect(key, execution).toBeTruthy();
      expect(RUN_STATE_BADGE[key], key).toBeTruthy();
      for (const dict of [en, ja]) expect(dict[`perspectives.run.state.${key}`], key).toBeTruthy();
    }
    // ADR-0010 reserves the freshness adjectives for drift, so the axis value
    // and the word the column prints are deliberately not the same.
    expect(perspRunState({ execution: "stale" })).not.toBe("stale");
    // A case the report does not mention is not a statement about its runs.
    expect(perspRunState({})).toBeNull();
  });

  test("the verdict column is not the execution column", () => {
    // They were one column before the axes were split. Sharing wording again
    // would put "needs re-run" where "how the last run ended" belongs.
    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) {
      expect(dict["perspectives.col.verdict"]).toBeTruthy();
      expect(dict["perspectives.col.audit"]).toBeTruthy();
      expect(dict["perspectives.col.verdict"]).not.toBe(dict["perspectives.col.run"]);
      expect(dict["perspectives.col.audit"]).not.toBe(dict["perspectives.col.run"]);
    }
  });

  test("the retired 'cannot tell' vocabulary is gone from both axes, not left dangling", () => {
    const { en, ja } = dictionaries();
    expect(ja["perspectives.rerun.state.rerunNeeded"]).toBe("要再実行");
    expect(ja["perspectives.rerun.state.verified"]).toBe("検証済み");
    expect(ja["perspectives.rerun.state.needsRepair"]).toBe("修正待ち");
    // One wording appeared twice meaning two different things — a verdict and
    // an audit state. Both are gone; a hole in the log is now an annotation on
    // a spec that is already pending, never a state of its own.
    for (const dict of [en, ja]) {
      for (const key of [
        "perspectives.rerun.state.unanswerable",
        "perspectives.audit.state.cannotTell",
        "perspectives.run.state.unknown",
        "perspectives.rerun.why.notEvaluated",
        "perspectives.rerun.fix.notEvaluated",
      ]) {
        expect(dict[key], `${key} is unused and should be gone`).toBeUndefined();
      }
    }
  });

  test("verified names what it was judged against, and noDeployLog is actionable", () => {
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

  test("a case with no verdict counts as work, never as an all-clear", () => {
    const { rerunComposition, rerunSegments } = composition();
    // Three cases the report does not mention — added since it was computed.
    const segments = rerunSegments(rerunComposition([null, null, null]));
    expect(segments.map((s) => s.state)).toEqual(["rerunNeeded"]);
    expect(segments[0]!.count).toBe(3);
    // The damaging render is a "verified" segment covering cases nothing was
    // said about — it reads as "nothing to do here".
    expect(segments.some((s) => s.state === "verified")).toBe(false);
  });

  test("work is never painted like a pass", () => {
    const { rerunComposition, rerunSegments } = composition();
    const counts = rerunComposition([null, { verdict: "verified" }, { verdict: "rerunNeeded" }]);
    expect(counts).toMatchObject({ rerunNeeded: 2, verified: 1 });
    const cls = Object.fromEntries(rerunSegments(counts).map((s) => [s.state, s.cls]));
    expect(cls.rerunNeeded).not.toBe(cls.verified);
    // `[^{}]*` rather than `\s*` so the class may share its rule with others
    // (drift's own states reuse these) — it cannot cross a rule boundary,
    // since braces are excluded.
    const rule = (c: string, v: string) => new RegExp(`\\.${c}[^{}]*\\{[^}]*var\\(--${v}\\)`);
    expect(HTML).not.toMatch(rule(cls.rerunNeeded!, "pass"));
    expect(HTML).toMatch(rule(cls.verified!, "pass"));
    // The retired verdict's colour went with it.
    expect(HTML).not.toContain("sg-unanswerable");
  });

  test("manually verified reads as a person's word, not a machine pass", () => {
    // A person's attestation overrides the verdict but is not the same claim
    // as the audit/run pipeline clearing a case, so it must not blend into
    // the "verified" pass colour.
    const { rerunComposition, rerunSegments } = composition();
    const cls = Object.fromEntries(
      rerunSegments(rerunComposition([{ verdict: "verified" }, { verdict: "manuallyVerified" }])).map((s) => [s.state, s.cls]),
    );
    expect(cls.manuallyVerified).toBe("sg-manual");
    const rule = (c: string, v: string) => new RegExp(`\\.${c}[^{}]*\\{[^}]*var\\(--${v}\\)`);
    expect(HTML).toMatch(rule(cls.manuallyVerified!, "violet"));
    expect(HTML).not.toMatch(rule(cls.manuallyVerified!, "pass"));
    // The table row's own badge map (VERDICT_BADGE) keeps the same split.
    expect(clientScript()).toContain('manuallyVerified: "rr-manual"');
  });

  test("every state the hub can send has a segment, and an unrecognised one is not an all-clear", () => {
    const { RERUN_ORDER, rerunComposition } = composition();
    for (const state of SpecVerdictSchema.options) expect(RERUN_ORDER).toContain(state);
    // A verdict a newer hub invents cannot be counted as "no action needed".
    const counts = rerunComposition([{ verdict: "somethingANewerHubSends" }]);
    expect(counts).toMatchObject({ rerunNeeded: 1, verified: 0, inProgress: 0 });
  });

  test("the verdict chips and the summary bar read an unrecognised verdict the same way", () => {
    const { rerunVerdictOf, rerunComposition } = composition();
    // rerunComposition is built from rerunVerdictOf (asserted below), so this
    // pins the one rule both the bar and perspMatches' chip filter answer to.
    for (const rr of [null, {}, { verdict: "somethingANewerHubSends" }] as ({ verdict?: string } | null)[]) {
      expect(rerunVerdictOf(rr)).toBe("rerunNeeded");
    }
    expect(rerunVerdictOf({ verdict: "verified" })).toBe("verified");
    expect(rerunComposition([{ verdict: "somethingANewerHubSends" }])).toMatchObject({ rerunNeeded: 1 });
    // perspMatches lives outside the pure region (it closes over perspState),
    // so pin at the source level that it defers to rerunVerdictOf rather than
    // keeping its own copy of the fallback — which is exactly how the two
    // drifted apart before this fix.
    const src = clientScript();
    const start = src.indexOf("function perspMatches");
    const end = src.indexOf("function perspFilterCount");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain("rerunVerdictOf(");
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
    // Three mode chips (all/deterministic/live) plus five verdict chips —
    // one per SpecVerdictSchema option, same words as the 判定 column.
    expect(HTML.match(/class="fcount"/g)).toHaveLength(8);
    expect(HTML).not.toMatch(/<button class="fchip"[^>]*data-i18n=/);
  });

  test("every verdict without an evidence row can still explain itself", () => {
    // The detail panel falls back to `rerunCannotJudge` for these, and a
    // missing key there renders as "this hub reported a reason this UI does
    // not recognise" — on a spec whose state the UI knows perfectly well.
    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) {
      expect(dict["perspectives.rerun.inProgressHint"]).toBeTruthy();
      expect(dict["perspectives.rerun.heldHint"]).toBeTruthy();
      for (const cause of ["testDrift", "specChange", "auditUndecided", "runFailed"]) {
        expect(dict[`perspectives.rerun.repair.${cause}`], cause).toBeTruthy();
      }
    }
  });

  test("a held spec is explained by the hold, not by an audit-log hole", () => {
    // rerunWhyVerdict isn't in a pure region (it closes over t()), so pin the
    // ordering at the source level: decide() (rerun.ts) returns "inProgress"
    // for a held spec before it even looks at the audit axis, so heldBy must
    // be checked before auditAssumedReached is reached for.
    const src = clientScript();
    const start = src.indexOf("function rerunWhyVerdict");
    const end = src.indexOf("function rerunRepairCause");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const heldIdx = body.indexOf("rr.heldBy");
    const auditHoleIdx = body.indexOf("rr.auditAssumedReached");
    expect(heldIdx).toBeGreaterThan(-1);
    expect(auditHoleIdx).toBeGreaterThan(-1);
    expect(heldIdx).toBeLessThan(auditHoleIdx);
  });

  test("the reason line names the deploy that caused the verdict when the hub reports one", () => {
    const { rerunChangeLine } = detailLabels();
    const head = { sha: "9999999999", at: "2026-07-25T00:00:00Z" };
    const line = rerunChangeLine(
      { verdict: "rerunNeeded", touchedByDeploy: { sha: "abcdef0123", at: "2026-07-20T00:00:00Z" } },
      head,
    );
    // The cause, not the head the judgement was made at, and with the time it
    // landed — which only a named cause carries.
    expect(line).toEqual({ key: "perspectives.rerun.changedByDeploy", sha: "abcdef0123", at: "2026-07-20T00:00:00Z" });

    const { en, ja } = dictionaries();
    for (const dict of [en, ja]) expect(dict["perspectives.rerun.changedByDeploy"]).toContain("{sha}");
    // The judgement-point wordings name the deploy too.
    for (const key of ["perspectives.rerun.changesSome", "perspectives.rerun.changesNone"]) {
      expect(ja[key]).toContain("{sha}");
      expect(en[key]).toContain("{sha}");
    }
  });

  test("without a named deploy the reason line keeps the weaker judgement-point wording", () => {
    const { rerunChangeLine } = detailLabels();
    const head = { sha: "9999999999", at: "2026-07-25T00:00:00Z" };
    // An older hub omits the field; a hub that could not confirm the entry
    // sends null. Neither may be dressed up as a cause, and neither takes a
    // timestamp — the head's time is not when the change landed.
    for (const rr of [{ verdict: "rerunNeeded" }, { verdict: "rerunNeeded", touchedByDeploy: null }]) {
      expect(rerunChangeLine(rr, head)).toEqual({
        key: "perspectives.rerun.changesSome",
        sha: head.sha,
        at: null,
      });
    }
    // verified has no touching deploy at all, so naming the head as the
    // judgement point stays correct there.
    expect(rerunChangeLine({ verdict: "verified" }, head)).toEqual({
      key: "perspectives.rerun.changesNone",
      sha: head.sha,
      at: null,
    });
    // A report with no deploy head contradicts both states; say that instead.
    expect(rerunChangeLine({ verdict: "verified" }, null)).toEqual({
      key: "perspectives.rerun.noDeployHead",
      sha: null,
      at: null,
    });
  });


  test("the panel repeats nothing the row already carries", () => {
    // The execution verdict is rendered in exactly one place — the table cell.
    // Two matches: the state function's definition and that single call.
    expect(clientScript().match(/perspRunState\(/g)).toHaveLength(2);
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
      // The reason card replaced the labelled evidence/failure rows, and the
      // spec id moved under the row title.
      "perspectives.d.changedSince",
      "perspectives.d.lastRed",
      "perspectives.d.spec",
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
    for (const id of ["persp-th-run", "persp-verdict-chips"]) {
      const tag = HTML.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
      expect(tag, `${id} is missing from the markup`).toBeTruthy();
      expect(tag![0]).toContain("hidden");
    }
    // Needs re-run is profile-scoped, so this tab carries its own selector.
    expect(HTML).toContain('id="persp-profile-switch"');
    expect(HTML).toContain('id="persp-profile-current"');
  });

  test("a profile with deploys but no runs is a reachable candidate for the first-open pick", () => {
    // The run index alone only knows "ci" here; "stg" only shows up once the
    // project's full profile set (dataProfileCandidates' third tier) is
    // folded in — that gap is exactly what let a deploy-only profile go
    // unoffered.
    const { dataProfileCandidates } = dataProfilePick();
    const candidates = dataProfileCandidates("default", ["ci"], ["default", "ci", "stg"]);
    expect(candidates).toEqual(["default", "ci", "stg"]);
    // No duplicates even when a name appears in every tier.
    expect(dataProfileCandidates("ci", ["ci"], ["ci"])).toEqual(["ci"]);
  });

  test("the first-open pick is decided by candidate order, not by which probe answers first", () => {
    const { pickFirstWithDeployLog } = dataProfilePick();
    const candidates = ["default", "ci", "stg"];
    // Only "stg" (index 2) actually has deploy data — it must win even though
    // it is neither the current profile nor a run-index profile.
    expect(pickFirstWithDeployLog(candidates, [false, false, true], "default", ["ci"])).toBe("stg");
    // Earlier candidates win ties, so a merely-plausible run-index profile
    // never bumps one probed and confirmed ahead of it in preference order.
    expect(pickFirstWithDeployLog(candidates, [false, true, true], "default", ["ci"])).toBe("ci");
    // Nothing confirms: fall back to the old run-index-only heuristic rather
    // than leaving the pick undefined.
    expect(pickFirstWithDeployLog(candidates, [false, false, false], "default", ["ci"])).toBe("ci");
  });

  test("a dismissal reads as active only when the hub says it settled the axis", () => {
    const { auditDismissalActive, auditOpen } = dismissalReading();
    const dismissed = { by: "a", at: "2026-07-01T00:00:00Z", note: "n", auditRunId: "r1", label: "TEST_DRIFT", headline: "h" };
    expect(auditDismissalActive({ audit: "clean", auditDismissed: dismissed, auditDismissalApplied: true })).toBe(true);
    // A later audit cleared the spec on its own. The axis reads the same, so
    // only the hub's own answer separates "a person settled this" from
    // "the machine did" — inferring it from `clean` would credit the wrong one.
    expect(auditDismissalActive({ audit: "clean", auditDismissed: dismissed, auditDismissalApplied: false })).toBe(false);
    expect(auditDismissalActive({ audit: "drifted", auditDismissed: dismissed, auditDismissalApplied: false })).toBe(false);
    expect(auditDismissalActive({ audit: "clean" })).toBe(false);
    // Both audit values that mean "the audit did not clear this spec".
    expect([auditOpen({ audit: "drifted" }), auditOpen({ audit: "undecided" })]).toEqual([true, true]);
    expect([auditOpen({ audit: "clean" }), auditOpen({ audit: "due" })]).toEqual([false, false]);
  });
});
