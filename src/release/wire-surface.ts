/**
 * The names the wire contract declares: the routes the hub serves, the keys
 * its schemas carry, the values its enums allow. Read at the previous tag and
 * again at HEAD, what disappeared between them is a breaking change — a path
 * list cannot tell an added field from a deleted one, and that difference is
 * the whole of `minor` vs `major`.
 *
 * What this deliberately does not see: an optional field made required, a
 * narrowed value range, a changed status code, a route whose semantics moved
 * under an unchanged name. Those break clients too and are left to review.
 * The claim here is only "a declared name went away", so a clean result is
 * not a compatibility guarantee.
 *
 * Extraction is textual, so it reads a revision without building it. That
 * holds because these files are one declaration per line; a name written
 * inside a single-line object literal is invisible to it.
 */

const ROUTE = /\brouter\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;

/** Route ids ("POST /api/v1/runs") registered in `src/hub/api/server.ts`. */
export function extractRoutes(source: string): string[] {
  const names = new Set<string>();
  for (const match of stripComments(source).matchAll(ROUTE)) {
    names.add(`${match[1]?.toUpperCase()} ${match[2]}`);
  }
  return [...names].sort();
}

/**
 * Ids declared by a zod schema module: `RunSchema.status` for an object key,
 * `RunStatusSchema:passed` for an enum or `as const` member.
 *
 * Members reached through a spread (`[...FAILURE_CAUSES, "UNKNOWN"]`) are
 * counted under the array that spells them out, so nothing is lost — the
 * composition is invisible, the names are not.
 */
export function extractSchemaNames(source: string): string[] {
  const names = new Set<string>();
  let declaration: string | null = null;
  let openList: string | null = null;

  for (const line of stripComments(source).split("\n")) {
    if (openList !== null) {
      for (const value of stringsIn(line)) names.add(`${openList}:${value}`);
      if (line.includes("]")) openList = null;
      continue;
    }

    // A top-level statement either opens a new declaration or ends the one
    // whose keys we were collecting; continuation lines start with `}`, `)`
    // or whitespace and leave it alone.
    if (/^[A-Za-z]/.test(line)) declaration = /^export const (\w+)\s*=/.exec(line)?.[1] ?? null;
    if (declaration === null) continue;

    const key = /^\s+([A-Za-z_]\w*):/.exec(line)?.[1];
    if (key) names.add(`${declaration}.${key}`);

    const list = /(?:z\.enum\(|=)\s*\[(.*)$/.exec(line);
    if (list) {
      const owner = key ? `${declaration}.${key}` : declaration;
      for (const value of stringsIn(list[1] ?? "")) names.add(`${owner}:${value}`);
      if (!(list[1] ?? "").includes("]")) openList = owner;
    }
  }

  return [...names].sort();
}

/** Names `before` declared and `after` does not. */
export function removedNames(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set(after);
  return before.filter((name) => !kept.has(name));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function stringsIn(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}
