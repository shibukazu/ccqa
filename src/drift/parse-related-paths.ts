/**
 * Pull a `RELATED_PATHS_BEGIN ... RELATED_PATHS_END` block out of the trace
 * agent's combined text output. Lines inside the block become entries; blank
 * lines, bullet markers, and code fences are tolerated. Returns null when the
 * agent did not emit a block at all so the caller can warn instead of silently
 * clearing the spec's existing relatedPaths.
 */
export function parseRelatedPathsBlock(text: string): string[] | null {
  const match = text.match(/RELATED_PATHS_BEGIN\s*\n?([\s\S]*?)\n?RELATED_PATHS_END/);
  if (!match || match[1] === undefined) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/^```.*$/, "").trim();
    if (!line) continue;
    const cleaned = line.replace(/^[-*]\s+/, "").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}
