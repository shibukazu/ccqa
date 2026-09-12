import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { addLanguageOption, DEFAULT_LANGUAGE } from "../cli/options.ts";
import { resolveLanguage } from "./language.ts";

describe("resolveLanguage", () => {
  test("the flag wins, then the project's own, then following the material", () => {
    expect(resolveLanguage("en", "ja")).toBe("en");
    expect(resolveLanguage(undefined, "ja")).toBe("ja");
    expect(resolveLanguage(undefined, undefined)).toBe(DEFAULT_LANGUAGE);
  });

  /**
   * The flag used to carry `auto` as its default value, which is
   * indistinguishable from the user passing it — so a project that set
   * `language` in its config never once saw it used, and every generated
   * comment and evidence table came out in English. Absent has to stay
   * absent for the order above to mean anything.
   */
  test("an unused --language does not out-rank the project's own", () => {
    const parsed = addLanguageOption(new Command().exitOverride())
      .parse(["node", "ccqa"])
      .opts<{ language?: string }>();
    expect(parsed.language).toBeUndefined();
    expect(resolveLanguage(parsed.language, "ja")).toBe("ja");
  });

  test("a used --language does", () => {
    const parsed = addLanguageOption(new Command().exitOverride())
      .parse(["node", "ccqa", "--language", "en"])
      .opts<{ language?: string }>();
    expect(resolveLanguage(parsed.language, "ja")).toBe("en");
  });
});
