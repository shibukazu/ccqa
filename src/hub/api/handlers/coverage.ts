import { InboxBodySchema, type StoredEvent } from "../../../coverage/events.ts";
import { decodeEncryptedBlob, decrypt, encodeEncryptedBlob, encrypt } from "../../core/crypto.ts";
import type { CoverageEventStore } from "../../core/storage/types.ts";
import { extractToken, isValidToken } from "../auth.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readJsonBody, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/**
 * The coverage inbox (ADR-0022): the hub stamps, stores, serves and expires
 * coverage events — it never looks inside one. Both handlers authenticate
 * here rather than in the server's central token check, because the inbox
 * accepts a second credential: `CCQA_HUB_COVERAGE_TOKEN`, the append-only
 * token the instrumented application holds. That token may append pushes and
 * nothing else — in particular no run events, so a leaked application
 * credential cannot forge the markers that bound a run's view of the stream.
 */

// Same bound as the run-local sink (src/coverage/sink.ts): the two inbox
// implementations must accept the same pushes.
const MAX_COVERAGE_BODY_BYTES = 8 * 1024 * 1024;

export interface CoverageHandlerConfig {
  store: CoverageEventStore;
  encryptionKey: Buffer | null;
  /** The hub bearer token — authorizes any event and all reads. */
  hubToken: string;
  /** The application's append-only token; unset means application pushes are refused (503). */
  coverageToken: string | undefined;
}

function requireKey(config: CoverageHandlerConfig): Buffer {
  // Actor events carry raw identity tags, so the stream is never stored in
  // the clear — no key, no inbox (the same stance the secret stores take).
  if (!config.encryptionKey) {
    throw new HttpError(503, "encryption_not_configured", "CCQA_HUB_ENCRYPTION_KEY is not set on this hub");
  }
  return config.encryptionKey;
}

function requireProjectParam(ctx: RouteContext): string {
  return requireSafeSegment(ctx.url.searchParams.get("project") ?? "", "project");
}

/** Which credential the request carries: the hub's own, or the application's append-only one. */
function authenticate(ctx: RouteContext, config: CoverageHandlerConfig): "hub" | "app" {
  const token = extractToken(ctx.req, ctx.url);
  if (isValidToken(token, config.hubToken)) return "hub";
  if (config.coverageToken === undefined) {
    throw new HttpError(503, "coverage_inbox_not_configured", "CCQA_HUB_COVERAGE_TOKEN is not set on this hub");
  }
  if (isValidToken(token, config.coverageToken)) return "app";
  throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
}

/** POST /api/v1/coverage/events?project= — stamp and append one event; 204 on receipt. */
export function createAppendCoverageEventHandler(config: CoverageHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const caller = authenticate(ctx, config);
    const key = requireKey(config);
    const project = requireProjectParam(ctx);
    const body = await readJsonBody(ctx.req, MAX_COVERAGE_BODY_BYTES, InboxBodySchema, "coverage event");
    // A push carries `protocol`, a run event carries `kind` (events.ts).
    if (caller === "app" && !("protocol" in body)) {
      throw new HttpError(
        403,
        "forbidden",
        "the coverage token appends application pushes only; run events require the hub bearer token",
      );
    }
    const payload = encodeEncryptedBlob(encrypt(new TextEncoder().encode(JSON.stringify(body)), key));
    await config.store.append(project, payload);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/**
 * GET /api/v1/coverage/events?project=&sinceSeq= — the stream after `sinceSeq`
 * (exclusive, so a consumer passes back the `lastSeq` it saw), decrypted.
 * Hub bearer token only: what the append-only credential wrote, it must not
 * be able to read back.
 */
export function createGetCoverageEventsHandler(config: CoverageHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    if (!isValidToken(extractToken(ctx.req, ctx.url), config.hubToken)) {
      throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
    }
    const key = requireKey(config);
    const project = requireProjectParam(ctx);
    const sinceSeq = requireSinceSeqParam(ctx.url);

    const { entries, lastSeq, skipped } = await config.store.read(project, sinceSeq);
    const events: StoredEvent[] = [];
    let unreadable = 0;
    for (const entry of entries) {
      // A rotated key or a corrupt payload loses that event, not the read;
      // it joins the store-level skips in the count the consumer sees.
      try {
        const plain = decrypt(decodeEncryptedBlob(entry.payload), key);
        const body = InboxBodySchema.parse(JSON.parse(new TextDecoder().decode(plain)));
        events.push({ seq: entry.seq, at: entry.at, body });
      } catch {
        unreadable += 1;
      }
    }
    sendJson(ctx.res, 200, { events, lastSeq, skipped: skipped + unreadable });
  };
}

/** Rejected rather than defaulted on garbage: a typo would otherwise read as "the whole stream". */
function requireSinceSeqParam(url: URL): number {
  const raw = url.searchParams.get("sinceSeq");
  if (raw === null || raw === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "invalid_param", "invalid sinceSeq: must be a non-negative integer");
  }
  return value;
}
