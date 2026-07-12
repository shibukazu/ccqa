import { describe, expect, test } from "vitest";
import type { RecordedAction } from "../types.ts";
import {
  detectUnstableLiterals,
  formatUnstableDrop,
  scrubUnstableActions,
} from "./literal-scrub.ts";

function action(partial: Partial<RecordedAction> & { action: RecordedAction["action"] }): RecordedAction {
  return partial as RecordedAction;
}

const css = (value: string) => ({ by: "css", value }) as const;

describe("detectUnstableLiterals — patterns", () => {
  test("clock-hms: HH:MM:SS in assert.value is a hit", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "Last updated 12:34:56" }),
    );
    expect(hits.map((h) => h.patternId)).toEqual(["clock-hms"]);
  });

  test("clock-hms: a plain HH:MM (no seconds) does NOT fire — too many false positives", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "Last updated 12:34" }),
    );
    expect(hits).toEqual([]);
  });

  test("iso-datetime: full ISO timestamp in observation fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "snapshot", observation: "Created at 2026-04-12T08:15:30Z" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("iso-datetime");
  });

  test("iso-date: YYYY-MM-DD on its own fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "2026-04-12" }),
    );
    expect(hits.map((h) => h.patternId)).toEqual(["iso-date"]);
  });

  test("iso-date: a version-like 2026 alone does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "Copyright 2026" }),
    );
    expect(hits).toEqual([]);
  });

  test("unix-epoch-sec: 10-digit value starting with `1` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "click", locator: css("[data-item-key='1779187735']") }),
    );
    expect(hits.map((h) => h.patternId)).toContain("unix-epoch-sec");
  });

  test("unix-epoch-sec: a 10-digit SKU that does NOT start with `1` is left alone", () => {
    const hits = detectUnstableLiterals(
      action({ action: "click", locator: css("[data-sku='9000000000']") }),
    );
    expect(hits).toEqual([]);
  });

  test("unix-epoch-ms: 13-digit value starting with `1` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "click", locator: css("[data-item-key='1779187735097']") }),
    );
    expect(hits.map((h) => h.patternId)).toContain("unix-epoch-ms");
  });

  test("relative-time-en: `5 minutes ago` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "Updated 5 minutes ago" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("relative-time-en");
  });

  test("relative-time-en: bare `5 minutes` (no `ago`) does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "Estimated wait: 5 minutes" }),
    );
    expect(hits).toEqual([]);
  });

  test("relative-now-en: `Just now` fires (case-insensitive)", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "just now" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("relative-now-en");
  });

  test("relative-time-ja: `3分前` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "3分前に更新" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("relative-time-ja");
  });

  test("relative-time-ja: bare `前` (e.g. `以前`) does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "以前の設定" }),
    );
    expect(hits).toEqual([]);
  });

  test("relative-now-ja: `たった今` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "たった今" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("relative-now-ja");
  });

  test("ja-date-full: `2026年5月20日` fires", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "作成日: 2026年5月20日" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("ja-date-full");
  });

  test("ja-date-md: `5月20日` fires when standalone", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "5月20日に作成" }),
    );
    expect(hits.map((h) => h.patternId)).toContain("ja-date-md");
  });

  test("ja-date-md: `5日間` (duration) does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "残り5日間" }),
    );
    expect(hits).toEqual([]);
  });

  test("ja-date-md: `30日目` (ordinal) does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "30日目の挑戦" }),
    );
    expect(hits).toEqual([]);
  });

  test("ja-date-md: bare `5月` (no day) does NOT fire", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "5月の予算" }),
    );
    expect(hits).toEqual([]);
  });

  test("ja-date-md: the `5月20日` portion of `2026年5月20日` is only flagged by ja-date-full (not ja-date-md)", () => {
    const hits = detectUnstableLiterals(
      action({ action: "assert", assert: "text_visible", value: "2026年5月20日" }),
    );
    const ids = hits.map((h) => h.patternId);
    expect(ids).toContain("ja-date-full");
    expect(ids).not.toContain("ja-date-md");
  });
});

describe("detectUnstableLiterals — field coverage", () => {
  test("scans locator.value, target.value, label, value, observation", () => {
    const hits = detectUnstableLiterals(
      action({
        action: "drag",
        locator: css("[data-time='12:34:56']"),
        target: css("[data-also='09:00:00']"),
        label: "13:00:00",
        value: "11:11:11",
        observation: "snapshot at 10:00:00",
      }),
    );
    expect(hits.map((h) => h.field).sort()).toEqual(
      ["label", "locator.value", "observation", "target.value", "value"],
    );
  });

  test("undefined / empty fields are skipped without throwing", () => {
    const hits = detectUnstableLiterals(action({ action: "cookies_clear" }));
    expect(hits).toEqual([]);
  });

  test("scans semantic locator values (e.g. `find text \"12:34:56\" click`)", () => {
    const hits = detectUnstableLiterals(
      action({ action: "click", locator: { by: "text", value: "12:34:56" } }),
    );
    expect(hits.map((h) => h.field)).toEqual(["locator.value"]);
    expect(hits[0]!.patternId).toBe("clock-hms");
  });

  test("scans role locator names (e.g. `find role button --name '2026-04-12'`)", () => {
    const hits = detectUnstableLiterals(
      action({ action: "click", locator: { by: "role", value: "button", name: "2026-04-12" } }),
    );
    expect(hits.map((h) => h.field)).toEqual(["locator.name"]);
    expect(hits[0]!.patternId).toBe("iso-date");
  });
});

describe("scrubUnstableActions — kept / dropped split", () => {
  test("safe actions pass through, hit actions are dropped, indices preserved", () => {
    const actions: RecordedAction[] = [
      { action: "navigate", value: "https://example.com" },
      { action: "click", locator: css("[aria-label='Submit']") },
      { action: "assert", assert: "text_visible", value: "Last updated 12:34:56" },
      { action: "click", locator: css("[aria-label='Next']") },
    ];
    const result = scrubUnstableActions(actions);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.index).toBe(2);
    expect(result.dropped[0]!.hits[0]!.patternId).toBe("clock-hms");
  });

  test("multiple consecutive hits are all dropped", () => {
    const actions: RecordedAction[] = [
      { action: "click", locator: css("[data-key='1779187735']") },
      { action: "assert", assert: "text_visible", value: "2026-04-12" },
      { action: "click", locator: css("[aria-label='OK']") },
    ];
    const result = scrubUnstableActions(actions);
    expect(result.dropped.map((d) => d.index)).toEqual([0, 1]);
    expect(result.kept).toEqual([{ action: "click", locator: { by: "css", value: "[aria-label='OK']" } }]);
  });

  test("snapshot with unstable observation is KEPT (cosmetic only)", () => {
    const actions: RecordedAction[] = [
      { action: "snapshot", observation: "loaded at 12:34:56" },
    ];
    const result = scrubUnstableActions(actions);
    expect(result.kept).toEqual(actions);
    expect(result.dropped).toEqual([]);
  });

  test("snapshot whose locator (not just observation) carries an unstable literal is dropped", () => {
    const actions: RecordedAction[] = [
      { action: "snapshot", locator: css("[data-key='1779187735']"), observation: "ok" },
    ];
    const result = scrubUnstableActions(actions);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });

  test("empty input yields empty result", () => {
    expect(scrubUnstableActions([])).toEqual({ kept: [], dropped: [] });
  });
});

describe("formatUnstableDrop", () => {
  test("includes action, assert type, patternId(s) and the matched substring", () => {
    const msg = formatUnstableDrop({
      index: 2,
      action: { action: "assert", assert: "text_visible", value: "now 12:34:56" },
      hits: [{ field: "value", patternId: "clock-hms", match: "12:34:56" }],
    });
    expect(msg).toContain("assert text_visible");
    expect(msg).toContain("clock-hms");
    expect(msg).toContain('value="12:34:56"');
  });

  test("dedupes patternIds when the same pattern matches multiple fields", () => {
    const msg = formatUnstableDrop({
      index: 0,
      action: { action: "drag", locator: css("12:34:56"), target: css("10:00:00") },
      hits: [
        { field: "locator.value", patternId: "clock-hms", match: "12:34:56" },
        { field: "target.value", patternId: "clock-hms", match: "10:00:00" },
      ],
    });
    expect(msg.match(/clock-hms/g)).toHaveLength(1);
  });
});
