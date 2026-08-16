/**
 * Entry points for servers `ccqa-tools/coverage/register` cannot wrap on its own:
 * anything that does not receive its requests from `node:http`.
 *
 * A framework running on plain Node needs none of this — the register hook
 * already opened the context before the framework saw the request.
 */

import { currentSpecId, runInSpec } from "./core.ts";
import { readBaggage, readCookie, writeBaggage } from "./wire.ts";

interface NodeLikeRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** connect / express / fastify-compat middleware. */
export function coverageMiddleware() {
  return function coverage(
    request: NodeLikeRequest,
    _response: unknown,
    next: () => void,
  ): void {
    const specId = specIdFromNodeHeaders(request.headers);
    if (specId === undefined) {
      next();
      return;
    }
    runInSpec(specId, next);
  };
}

/** Wraps a `Request` -> `Response` handler (Hono, Next.js route handlers, workerd). */
export function withCoverage<A extends unknown[], R>(
  handler: (request: Request, ...rest: A) => R,
): (request: Request, ...rest: A) => R {
  return function covered(request: Request, ...rest: A): R {
    const specId =
      readCookie(request.headers.get("cookie")) ?? readBaggage(request.headers.get("baggage"));
    if (specId === undefined) return handler(request, ...rest);
    return runInSpec(specId, () => handler(request, ...rest));
  };
}

/**
 * Converts the cookie into a `baggage` header so downstream services — which
 * never see the browser's cookie jar — inherit the attribution. Call it where
 * the first service fans out, or in an edge middleware that forwards to one.
 */
export function forwardHeaders(incoming: Headers, outgoing?: Headers): Headers {
  const headers = outgoing ?? new Headers();
  const specId =
    currentSpecId() ??
    readCookie(incoming.get("cookie")) ??
    readBaggage(incoming.get("baggage"));
  if (specId !== undefined) {
    headers.set("baggage", writeBaggage(headers.get("baggage") ?? incoming.get("baggage"), specId));
  }
  return headers;
}

function specIdFromNodeHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return readCookie(single(headers.cookie)) ?? readBaggage(single(headers.baggage));
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
