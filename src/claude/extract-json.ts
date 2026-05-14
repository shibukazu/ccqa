/**
 * Pulls a JSON object out of a Claude completion. Accepts either a fenced
 * ```json block or a bare `{...}` payload that constitutes the whole reply.
 * Returns null when neither shape is present.
 */
export function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  return null;
}
