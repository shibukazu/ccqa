import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Constant-time comparison against the hub's bearer token, so response
 * timing can't be used to guess the token character-by-character. Accepts
 * the token either as an `Authorization: Bearer <token>` header or, for
 * read-only GET endpoints only (the artifacts download is a browser `<a>` that can't
 * carry a header), a `?token=` query parameter — see docs/hub-api.md for
 * the security tradeoff that accepts.
 */
export function extractToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return url.searchParams.get("token");
}

export function isValidToken(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
