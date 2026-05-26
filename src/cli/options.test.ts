import { describe, expect, test } from "vitest";
import { Command } from "commander";
import { addLanguageOption, DEFAULT_LANGUAGE, languageDirective, useJapanesePrompts } from "./options.ts";

describe("languageDirective", () => {
  test("returns empty for 'auto' so prompts stay material-following", () => {
    expect(languageDirective("auto")).toBe("");
  });

  test("returns empty for undefined / empty (treated as auto)", () => {
    expect(languageDirective(undefined)).toBe("");
    expect(languageDirective("")).toBe("");
    expect(languageDirective("  ")).toBe("");
  });

  test("pins output to an explicit BCP-47 tag", () => {
    const out = languageDirective("ja");
    expect(out).toContain("**ja**");
    expect(out).toMatch(/Write every human-readable field/);
  });

  test("trims surrounding whitespace on the tag", () => {
    expect(languageDirective("  en ")).toContain("**en**");
  });
});

describe("useJapanesePrompts", () => {
  test("true only for an explicit Japanese tag", () => {
    expect(useJapanesePrompts("ja")).toBe(true);
    expect(useJapanesePrompts("ja-JP")).toBe(true);
    expect(useJapanesePrompts("JA")).toBe(true);
    expect(useJapanesePrompts("  ja ")).toBe(true);
  });

  test("false for auto / en / undefined so English prompts stay the default", () => {
    expect(useJapanesePrompts("auto")).toBe(false);
    expect(useJapanesePrompts("en")).toBe(false);
    expect(useJapanesePrompts(undefined)).toBe(false);
    expect(useJapanesePrompts("")).toBe(false);
    // not a word-boundary match (avoids false positives like "japanese-ish")
    expect(useJapanesePrompts("java")).toBe(false);
  });
});

describe("addLanguageOption", () => {
  test("adds a --language flag defaulting to auto", () => {
    const cmd = addLanguageOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse([], { from: "user" });
    expect(cmd.opts().language).toBe(DEFAULT_LANGUAGE);
  });

  test("parses an explicit --language value", () => {
    const cmd = addLanguageOption(new Command("demo").exitOverride());
    cmd.action(() => {});
    cmd.parse(["--language", "ja"], { from: "user" });
    expect(cmd.opts().language).toBe("ja");
  });
});
