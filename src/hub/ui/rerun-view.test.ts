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
