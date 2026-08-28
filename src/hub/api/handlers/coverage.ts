import { InboxBodySchema, type StoredEvent } from "../../../coverage/events.ts";
import { listRunIds, StreamResolution, type ResolvedCoverage } from "../../../coverage/resolve-stream.ts";
import { decodeEncryptedBlob, decrypt, encodeEncryptedBlob, encrypt } from "../../core/crypto.ts";
import type { CoverageEdgeStore, CoverageEventStore } from "../../core/storage/types.ts";
import { extractToken, isValidToken } from "../auth.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readJsonBody, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";
import { CoverageEdgesUpsertSchema } from "../../contract/schema.ts";

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
 * (exclusive), decrypted, at most `MAX_EVENTS_PER_READ` of them. A consumer
 * passes back the `seq` of the last event it received; `lastSeq` is the
 * stream's head, which `truncated` says the body stopped short of.
 * Hub bearer token only (the server's central check): what the append-only
 * credential wrote, it must not be able to read back.
 */
export function createGetCoverageEventsHandler(config: CoverageHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const project = requireProjectParam(ctx);
    const sinceSeq = requireSinceSeqParam(ctx.url);
    // Capped rather than unbounded: this endpoint answers with one body, so a
    // caller that asks from 0 would otherwise ask the hub to hold the whole
    // stream at once.
    const events: StoredEvent[] = [];
    let truncated = false;
    const { lastSeq, skipped } = await scanStream(config, key, project, sinceSeq, (event) => {
      if (events.length < MAX_EVENTS_PER_READ) events.push(event);
      else truncated = true;
    });
    // `lastSeq` stays the stream's head, so a caller can see how far behind it
    // is. It is not the resume cursor once the body was cut — that is the last
    // event actually sent, and `truncated` is what says the two differ.
    sendJson(ctx.res, 200, { events, lastSeq, skipped, truncated });
  };
}

/**
 * Hand each event after `sinceSeq` (exclusive) to `visit`, decrypted and
 * parsed. Nothing is retained here: what a caller keeps is its own choice,
 * which is what lets a whole-stream read stay bounded.
 */
async function scanStream(
  config: CoverageHandlerConfig,
  key: Buffer,
  project: string,
  sinceSeq: number,
  visit: (event: StoredEvent) => void,
): Promise<{ lastSeq: number; skipped: number }> {
  let unreadable = 0;
  const { lastSeq, skipped } = await config.store.scan(project, sinceSeq, (entry) => {
    let event: StoredEvent;
    // A rotated key or a corrupt payload loses that event, not the read; it
    // joins the store-level skips in the count the consumer sees. The visit
    // stays outside: a consumer that throws has not found a hole in the
    // stream, and reporting one would hide its own fault.
    try {
      const plain = decrypt(decodeEncryptedBlob(entry.payload), key);
      event = { seq: entry.seq, at: entry.at, body: InboxBodySchema.parse(JSON.parse(new TextDecoder().decode(plain))) };
    } catch {
      unreadable += 1;
      return;
    }
    visit(event);
  });
  return { lastSeq, skipped: skipped + unreadable };
}

/** Newest runs the resolve read offers; past twenty the answer is history nobody pages through. */
const RUN_IDS_LIMIT = 20;

/** How many events one `GET /events` body carries; past it the answer is `truncated`. */
const MAX_EVENTS_PER_READ = 5_000;

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

    // Two scans, keeping only the markers between them. Every push the stream
    // holds still reaches the resolver, but none of them is held: the stream
    // outgrows this process long before it outgrows its own retention.
    const markers: StoredEvent[] = [];
    let seen = 0;
    const first = await scanStream(config, key, project, 0, (event) => {
      seen += 1;
      if ("kind" in event.body) markers.push(event);
    });
    const runIds = listRunIds(markers).slice(0, RUN_IDS_LIMIT);
    const runId = runKey !== "" ? runKey : runIds[0];
    let resolved: ResolvedCoverage | null = null;
    if (runId !== undefined && seen > 0) {
      const resolution = new StreamResolution(markers, runId);
      // Stops where the first scan stopped. The markers behind the resolver
      // were frozen there, so a later event would be read against a context
      // that never saw its own marker: a push crediting a spec the resolver
      // was not told had opened counts as rejected, which reads as a fault in
      // the run rather than in the read.
      await scanStream(config, key, project, 0, (event) => {
        if (event.seq <= first.lastSeq) resolution.accept(event);
      });
      resolved = resolution.finish();
    }
    const answer: CoverageAnswer = { resolved, runIds };
    // Both scans stop at this position, so it is exactly what the answer
    // covers — an event landing between them changes neither.
    memo.put(project, runKey, first.lastSeq, answer);
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

// ── coverage-edge ledger (ADR-0026) ──────────────────────────────────────

const MAX_EDGES_BODY_BYTES = 8 * 1024 * 1024;

export interface CoverageEdgeHandlerConfig {
  store: CoverageEdgeStore;
}

/**
 * PUT /api/v1/projects/:project/coverage-edges — the specs one run measured,
 * merged into the ledger newest-wins. `measuredAt` is stamped here with the
 * hub's clock, so entries written by different runners stay comparable.
 * Bearer-authenticated like every project route; the append-only coverage
 * token cannot write here.
 */
export function createPutCoverageEdgesHandler(config: CoverageEdgeHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const body = await readJsonBody(ctx.req, MAX_EDGES_BODY_BYTES, CoverageEdgesUpsertSchema, "coverage-edges body");
    await config.store.merge(project, body.specs, Date.now());
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** GET /api/v1/projects/:project/coverage-edges — the ledger, or 404. */
export function createGetCoverageEdgesHandler(config: CoverageEdgeHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const doc = await config.store.get(project);
    if (doc === null) {
      throw new HttpError(404, "not_found", `no coverage edges stored for project "${project}"`);
    }
    sendJson(ctx.res, 200, doc);
  };
}
