/**
 * Formatting helpers shared by the Claude prompt builders (diagnose, report,
 * drift). Centralised so the prompts cannot drift apart on mechanics that
 * must stay consistent across commands.
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

/**
 * The `spec`/`generated` surface-axis definitions, plus the "if both are
 * stale, answer spec" tie-break rule. Shared verbatim by the audit prompt
 * (`prompts/drift.ts`) and the run's failure-classification prompt
 * (`report/prompt.ts`): both fill the same wire field (`DriftSurfaceSchema`),
 * so a diverging definition in one would make the two paths disagree on what
 * a spec's own field means.
 */
export function surfaceDefinitionBlock(): string {
  return `- **\`spec\`** — spec.yaml asks about something the source no longer has. It has to be rewritten, and the code regenerated after.
- **\`generated\`** — the spec still describes the product correctly, but the generated code reaches for a selector or string the source no longer has. Only a regeneration is needed; nobody has to rewrite the spec.

If both are stale, answer \`spec\`: it is the root, and fixing it regenerates the code.`;
}

/**
 * "surface is a separate axis from the label" clarifying example, shared for
 * the same reason as {@link surfaceDefinitionBlock}. `labelToken` is the
 * exact text to name the label by (e.g. `"TEST_DRIFT"` or `` "`TEST_DRIFT`" ``)
 * so each caller keeps its own backtick/bold convention.
 */
export function surfaceAxisAside(labelToken: string): string {
  return `This is a separate axis from the label. A renamed selector that only the generated code names is ${labelToken} on the \`generated\` surface; a spec whose \`expected\` quotes a string the product renamed is ${labelToken} on the \`spec\` surface.`;
}
