import { InboxBodySchema, type StoredEvent } from "../../../coverage/events.ts";
import { listRunIds, resolveStream, type ResolvedCoverage } from "../../../coverage/resolve-stream.ts";
import { decodeEncryptedBlob, decrypt, encodeEncryptedBlob, encrypt } from "../../core/crypto.ts";
import type { CoverageEventStore } from "../../core/storage/types.ts";
import { extractToken, isValidToken } from "../auth.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readJsonBody, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/**
 * The coverage inbox (ADR-0022): the hub stamps, stores, serves and expires
 * coverage events — it never looks inside one, except the read-time resolve
 * below, the one bounded amendment ADR-0022 makes to the no-compute rule.
 * The append authenticates here rather than in the server's central token
 * check, because it accepts a second credential:
 * `CCQA_HUB_COVERAGE_TOKEN`, the append-only token the instrumented
 * application holds. That token may append pushes and nothing else — in
 * particular no run events, so a leaked application credential cannot forge
 * the markers that bound a run's view of the stream. The reads stay behind
 * the central check (see SELF_AUTHENTICATED_ROUTES in server.ts).
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
 * Hub bearer token only (the server's central check): what the append-only
 * credential wrote, it must not be able to read back.
 */
export function createGetCoverageEventsHandler(config: CoverageHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const project = requireProjectParam(ctx);
    const sinceSeq = requireSinceSeqParam(ctx.url);
    sendJson(ctx.res, 200, await readStream(config, key, project, sinceSeq));
  };
}

/** The stored stream after `sinceSeq` (exclusive), decrypted and parsed. */
async function readStream(
  config: CoverageHandlerConfig,
  key: Buffer,
  project: string,
  sinceSeq: number,
): Promise<{ events: StoredEvent[]; lastSeq: number; skipped: number }> {
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
  return { events, lastSeq, skipped: skipped + unreadable };
}

/** Newest runs the resolve read offers; past twenty the answer is history nobody pages through. */
const RUN_IDS_LIMIT = 20;

/** Resolved answers kept per handler; one page polls one key, so a handful covers the readers. */
const RESOLVE_CACHE_LIMIT = 8;

/** The whole body GET /api/v1/coverage serves — memoized as one, so a hit skips the read entirely. */
export interface CoverageAnswer {
  resolved: ResolvedCoverage | null;
  runIds: string[];
}

/**
 * Memo of served answers keyed by stream position (ADR-0022: a resolved
 * answer may be cached keyed by stream position, but the cache is never the
 * record). Any new event moves the stream's seq, so a stored answer can only
 * ever be served for exactly the stream it was computed from — which is what
 * lets the handler answer a hit without reading the stream at all.
 * Least-recently-used beyond `limit`. `runKey` is the requested runId, or ""
 * for "the latest run". Unambiguous join: `project` is a safe segment (no
 * newline) and the trailing element is a number, so `runKey` cannot forge
 * another key.
 */
export function createResolveMemo(limit: number): {
  get(project: string, runKey: string, seq: number): CoverageAnswer | undefined;
  put(project: string, runKey: string, seq: number, answer: CoverageAnswer): void;
} {
  const cache = new Map<string, CoverageAnswer>();
  const keyOf = (project: string, runKey: string, seq: number) => `${project}\n${runKey}\n${seq}`;
  return {
    get(project, runKey, seq) {
      const cacheKey = keyOf(project, runKey, seq);
      const hit = cache.get(cacheKey);
      if (hit !== undefined) {
        // Re-insert so eviction drops the least recently asked-for answer.
        cache.delete(cacheKey);
        cache.set(cacheKey, hit);
      }
      return hit;
    },
    put(project, runKey, seq, answer) {
      cache.set(keyOf(project, runKey, seq), answer);
      if (cache.size > limit) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
  };
}

/**
 * GET /api/v1/coverage?project=[&runId=] — the stream, interpreted for one
 * run by the shared resolver (resolve-stream.ts); this handler only reads,
 * memoizes and serves. `runId` omitted means the run the stream most
 * recently heard a spec-open from — the page's default view; naming one
 * serves history. Hub bearer token only (the central check), like the raw
 * read.
 */
export function createResolveCoverageHandler(config: CoverageHandlerConfig) {
  const memo = createResolveMemo(RESOLVE_CACHE_LIMIT);
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const project = requireProjectParam(ctx);
    const requested = ctx.url.searchParams.get("runId");
    const runKey = requested !== null && requested !== "" ? requested : "";

    // The cheap probe first: pages poll this endpoint, and most polls find
    // the stream where they left it — those must not pay for a full read
    // and decrypt of the stream just to serve the answer already computed.
    const seq = await config.store.currentSeq(project);
    const hit = memo.get(project, runKey, seq);
    if (hit !== undefined) {
      sendJson(ctx.res, 200, hit);
      return;
    }

    const { events, lastSeq } = await readStream(config, key, project, 0);
    const runIds = listRunIds(events).slice(0, RUN_IDS_LIMIT);
    const runId = runKey !== "" ? runKey : runIds[0];
    const resolved = runId === undefined || events.length === 0 ? null : resolveStream(events, runId);
    const answer: CoverageAnswer = { resolved, runIds };
    // Keyed at the seq the read actually saw — an event landing between the
    // probe and the read must not pin this answer to the older position.
    memo.put(project, runKey, lastSeq, answer);
    sendJson(ctx.res, 200, answer);
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
