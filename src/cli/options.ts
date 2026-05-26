import type { Command } from "commander";
import { DEFAULT_LANGUAGE } from "../prompts/language.ts";

export { DEFAULT_LANGUAGE, languageDirective } from "../prompts/language.ts";

/**
 * Shared `--language` flag. Every Claude-driven command writes some
 * human-readable text, so language is a cross-cutting concern handled the same
 * way everywhere — much like `--model`. The value is a BCP-47 tag (e.g. "ja",
 * "en") or "auto" (default), which follows the language of the material.
 */
export function addLanguageOption(command: Command): Command {
  return command.option(
    "--language <bcp47>",
    "Language for human-readable output (e.g. 'en', 'ja'). Default 'auto' follows the language of the spec/codebase.",
    DEFAULT_LANGUAGE,
  );
}
