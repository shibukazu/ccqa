/**
 * Shared language handling for every Claude-driven command. Each command
 * writes some human-readable text (drift findings, trace observations, draft
 * prose, diagnose hints, perspectives summaries), so the language policy is a
 * single cross-cutting concern rather than per-command logic.
 *
 * The value is a BCP-47 tag (e.g. "ja", "en") or the sentinel "auto". With
 * "auto" the model follows the language of the material it is given — Japanese
 * specs/codebase yield Japanese output — and `languageDirective` returns an
 * empty string so prompts stay byte-identical to the no-flag baseline.
 */
export const DEFAULT_LANGUAGE = "auto";

/**
 * The instruction appended to a command's system prompt. Empty for "auto"
 * (and undefined / blank), so the model keeps its natural material-following
 * behaviour; otherwise it pins every human-readable field to the given tag.
 */
export function languageDirective(language: string | undefined): string {
  const lang = (language ?? DEFAULT_LANGUAGE).trim();
  if (lang === "" || lang === DEFAULT_LANGUAGE) return "";
  return `\n\nIMPORTANT: Write every human-readable field, message, and explanation in **${lang}** (BCP-47 language tag), regardless of the language of the spec or codebase.`;
}

/**
 * Whether the CLI's own interactive prompts (the strings ccqa prints itself,
 * not the model's output) should be Japanese. Only an explicit Japanese tag
 * (`ja`, `ja-JP`, …) opts in; `auto` (the default) and every other tag keep
 * the English prompts, so an English user running with no flag is unaffected.
 */
export function useJapanesePrompts(language: string | undefined): boolean {
  return /^ja\b/i.test((language ?? "").trim());
}
