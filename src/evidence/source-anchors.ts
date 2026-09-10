import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { SourceRoot } from "../config/source-roots.ts";

/**
 * A mechanical stand-in for a reviewer grepping the product's source by hand:
 * exact substring, first match wins, no LLM. The evidence table asks it "does
 * this locator value appear anywhere in the source" and gets a file:line or an
 * honest "not found" — never a guess.
 */

export interface SourceAnchor {
  /** The string that was searched for. */
  needle: string;
  /** `path:line`, path relative to the root it was found under, prefixed by that root as configured. */
  at: string;
}

export interface SourceAnchors {
  found: Map<string, SourceAnchor>;
  /**
   * Needles this never looked for, or stopped looking for. An unresolved
   * needle in here means "not looked at", not "not there", and the two must
   * not be shown the same way — the whole value of the column is that
   * "not found" is a fact about the product.
   */
  unsearched: Set<string>;
}

/**
 * Extensions this scan reads. An allowlist, not a denylist: the corpus is
 * "whatever the reviewer's product repo contains", and a denylist would have
 * to keep chasing every generated, vendored or binary extension a project
 * might add. What a locator's text is rendered from is either UI source or a
 * server-side template, so both kinds are named here.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro", ".html", ".htm",
  ".erb", ".haml", ".slim", ".php", ".twig", ".blade", ".liquid", ".hbs", ".ejs", ".mustache",
  ".jsp", ".cshtml", ".razor", ".templ", ".rb", ".py", ".go", ".java", ".kt", ".cs", ".rs", ".ex", ".exs",
]);

/** Directory names that are never a product's own UI source. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/**
 * Source files under `rootAbs`, breadth-first. Level-order (not depth-first)
 * matters here: a shallow, likely-relevant file should be read before this
 * scan burns its file budget descending into one deep subtree.
 */
async function* walkSourceFiles(rootAbs: string): AsyncGenerator<string> {
  let level: string[] = [rootAbs];
  while (level.length > 0) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          next.push(join(dir, entry.name));
        } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
          yield join(dir, entry.name);
        }
      }
    }
    level = next;
  }
}

/** A configured root joined to a path found under it, `/`-separated regardless of the root's own trailing slash. */
function anchorAt(configured: string, relPath: string, line: number): string {
  const prefix = configured.endsWith("/") ? configured : `${configured}/`;
  return `${prefix}${relPath}:${line}`;
}

/**
 * First file:line each needle appears in, across `roots` in configured order.
 *
 * Bounded on purpose — this runs on every `ccqa evidence` call, on a
 * reviewer's machine, so it has to behave like a lookup rather than a
 * full-repo grep. Hitting `maxFiles` is not an error, but it is not a result
 * either: whatever was still unresolved lands in `unsearched`, so the table
 * can say "we stopped looking" rather than "the product does not have this".
 *
 * A needle resolved under an earlier root is not searched for again under a
 * later one, so roots double as priority order, not just search order.
 */
export async function findSourceAnchors(
  needles: readonly string[],
  roots: readonly SourceRoot[],
  opts?: { maxFiles?: number; maxFileBytes?: number },
): Promise<SourceAnchors> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  // Shorter/blank needles match nearly every line — noise, not evidence. They
  // are reported as unsearched rather than dropped: a reviewer must not read
  // "not found" about a string nothing ever looked for.
  const pending = new Set<string>();
  const unsearched = new Set<string>();
  for (const needle of needles) (needle.trim().length >= 3 ? pending : unsearched).add(needle);
  const found = new Map<string, SourceAnchor>();

  let filesRead = 0;
  for (const root of roots) {
    if (pending.size === 0) break;
    for await (const fileAbs of walkSourceFiles(root.abs)) {
      if (pending.size === 0) return { found, unsearched };
      if (filesRead >= maxFiles) return { found, unsearched: union(unsearched, pending) };
      filesRead++;
      const info = await stat(fileAbs).catch(() => null);
      if (!info || info.size > maxFileBytes) continue;
      const content = await readFile(fileAbs, "utf8").catch(() => null);
      if (content === null) continue;
      const relPath = relative(root.abs, fileAbs);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && pending.size > 0; i++) {
        const line = lines[i]!;
        for (const needle of pending) {
          if (line.includes(needle)) {
            found.set(needle, { needle, at: anchorAt(root.configured, relPath, i + 1) });
            pending.delete(needle);
          }
        }
      }
    }
  }
  return { found, unsearched };
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  return new Set([...a, ...b]);
}
