/**
 * Collapse a repeated `/` in a URL's path.
 *
 * A base URL ending in `/` and a written `/path` is how one arrives, and the
 * product answers `//path` differently from `/path` — a list that never
 * renders, and every assertion after it reading zero. Applied where a URL is
 * recorded and again where one is resolved, so a route recorded before this
 * existed still replays against the URL the product has.
 */
export function collapseUrlPath(url: string): string {
  // Only after the authority: `file:///repo/x` is three slashes by design, and
  // collapsing one turns its first path segment into a host.
  const scheme = url.indexOf("://");
  if (scheme === -1) return url;
  const pathAt = url.indexOf("/", scheme + 3);
  if (pathAt === -1) return url;
  const end = url.slice(pathAt).search(/[?#]/);
  const stop = end === -1 ? url.length : pathAt + end;
  const path = url.slice(pathAt, stop);
  const collapsed = path.replace(/\/{2,}/g, "/");
  // Returned untouched when nothing moved: `ir.json`'s parse is pinned as a
  // round-trip, and `URL` would rewrite a bare origin to one with a root path.
  return collapsed === path ? url : url.slice(0, pathAt) + collapsed + url.slice(stop);
}
