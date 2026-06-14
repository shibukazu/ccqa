import { describe, expect, test } from "vitest";
import { reportStrings, resolveReportLocale } from "./i18n.ts";

describe("resolveReportLocale", () => {
  test("returns 'en' for null / undefined / empty / 'auto'", () => {
    expect(resolveReportLocale(null)).toBe("en");
    expect(resolveReportLocale(undefined)).toBe("en");
    expect(resolveReportLocale("")).toBe("en");
    expect(resolveReportLocale("auto")).toBe("en");
  });

  test("strips region tags so 'ja-JP' / 'JA_jp' map to 'ja'", () => {
    expect(resolveReportLocale("ja")).toBe("ja");
    expect(resolveReportLocale("ja-JP")).toBe("ja");
    expect(resolveReportLocale("JA_jp")).toBe("ja");
  });

  test("falls back to 'en' for locales we don't ship strings for", () => {
    expect(resolveReportLocale("fr")).toBe("en");
    expect(resolveReportLocale("zh-CN")).toBe("en");
  });
});

describe("reportStrings", () => {
  test("returns the English strings by default", () => {
    expect(reportStrings(null).title).toBe("ccqa run report");
    expect(reportStrings(null).predictionAccuracy).toBe("Prediction accuracy");
  });

  test("returns Japanese strings when the language resolves to ja", () => {
    expect(reportStrings("ja").title).toBe("ccqa 実行レポート");
    expect(reportStrings("ja-JP").predictionAccuracy).toBe("予測精度");
  });

  test("stepEvidence is a function that takes a count", () => {
    expect(reportStrings(null).stepEvidence(3)).toBe("Step evidence (3)");
    expect(reportStrings("ja").stepEvidence(3)).toBe("ステップ証跡 (3)");
  });
});
