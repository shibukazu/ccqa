import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Reads the token from `Authorization: Bearer <token>`, or — on GET only —
 * from `?token=`. A query token leaks through `Referer`, history and proxy
 * logs, so it is accepted only where a browser `<a>` can't send a header;
 * see docs/hub-api.md.
 */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  if (req.method !== "GET") return null;
  return url.searchParams.get("token");
}

/**
 * Constant-time comparison against the hub's bearer token, so response
 * timing can't be used to guess the token character-by-character.
 */
export function isValidToken(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
