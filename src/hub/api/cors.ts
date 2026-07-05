import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Apply CORS headers when the request's Origin is in the configured
 * allowlist. Returns true when the caller should stop (an OPTIONS
 * preflight was fully handled here); false means the caller should
 * continue to the route handler.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}
