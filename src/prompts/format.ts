/**
 * Formatting helpers shared by the Claude prompt builders (diagnose, report).
 * Centralised so the prompts cannot drift apart on mechanics that must stay
 * consistent across commands.
 */

/** Prefix every line with its 1-based number, the form fix suggestions cite. */
export function numberLines(script: string): string {
  return script
    .split("\n")
    .map((l, i) => `${i + 1}: ${l}`)
    .join("\n");
}

/**
 * The "## Output language" prompt section. Empty for "auto" so the prompt
 * stays byte-identical to the no-flag baseline. `fields` names the
 * human-readable JSON fields to translate; `verbatimNames` names the
 * enum-like values that must never be translated.
 */
export function outputLanguageBlock(
  outputLanguage: string,
  fields: string,
  verbatimNames: string,
): string {
  if (outputLanguage === "auto") return "";
  return `## Output language

Write all human-readable fields (${fields}) in **${outputLanguage}** (BCP-47 tag).
Selectors, file paths, identifiers, ${verbatimNames}, JSON keys, and quoted strings stay verbatim regardless of language.

`;
}
