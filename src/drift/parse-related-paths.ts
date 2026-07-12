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

/**
 * Normalize parsed entries to the canonical bases the drift matcher expects:
 * app-relative for files inside the working directory, repo-root-relative
 * for files outside it. Models sometimes emit an in-app path in repo-root
 * form (`apps/foo/src/...`) or an outside-package path in `../` form — both
 * would silently never match.
 *
 * `cwdPrefix` is the working directory's path relative to the repo root
 * ("" when they coincide, unknown → pass `null` to skip prefix handling).
 */
export function normalizeRelatedPaths(
  paths: string[],
  cwdPrefix: string | null,
): { paths: string[]; warnings: string[] } {
  const out: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "");
    if (cwdPrefix !== null && cwdPrefix !== "" && p.startsWith(`${cwdPrefix}/`)) {
      push(p.slice(cwdPrefix.length + 1));
      continue;
    }
    if (p.startsWith("../")) {
      if (cwdPrefix === null || cwdPrefix === "") {
        warnings.push(`dropped relatedPaths entry "${raw}" — it points outside the repository`);
        continue;
      }
      // Re-express relative-to-cwd escapes as repo-root-relative so the
      // cross-package matching in drift --changed can see them.
      const segments = [...cwdPrefix.split("/"), ...p.split("/")];
      const resolved: string[] = [];
      let escaped = false;
      for (const seg of segments) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
          if (resolved.length === 0) {
            escaped = true;
            break;
          }
          resolved.pop();
        } else {
          resolved.push(seg);
        }
      }
      if (escaped || resolved.length === 0) {
        warnings.push(`dropped relatedPaths entry "${raw}" — it points outside the repository`);
        continue;
      }
      push(resolved.join("/"));
      continue;
    }
    push(p);
  }
  return { paths: out, warnings };
}
