/**
 * The names a spec id travels under. Every carrier holds the same value,
 * `<runId>.<specId>`, so a hop between them is a copy and never a translation.
 *
 * Like `core.ts` this file imports nothing: the Temporal workflow sandbox reads
 * it too.
 */

/** Set on the browser by ccqa at spec start, scoped to the target origin. */
export const COOKIE_NAME = "__ccqa_coverage";

/** OTel baggage key, for the hop from the first service to downstream ones. */
export const BAGGAGE_KEY = "ccqa.coverage";

/** Temporal header key, for the hop from client to workflow to activity. */
export const TEMPORAL_HEADER = "ccqa-tools";

/**
 * Enables the instrumentation. Unset means the register hook is never loaded
 * and the application pays nothing at all.
 *
 * `1` / `true` turns it on and leaves attribution to the incoming carrier.
 * Any other value is itself a `<runId>.<specId>` and becomes the ambient spec
 * for the process — the only way to attribute an entry point that has no
 * inbound request to read, such as a worker started per spec.
 */
export const ENV_NAME = "CCQA_COVERAGE";

/** Where the collector pushes to. Unset means the run's loopback inbox. */
export const ENV_ENDPOINT = "CCQA_COVERAGE_ENDPOINT";

/**
 * Sent as a bearer token. The hub's coverage inbox verifies it; the loopback
 * sink a local run binds does not check it, as before — there it is carried
 * for a relay in front of the sink.
 */
export const ENV_TOKEN = "CCQA_COVERAGE_TOKEN";

/**
 * One extra `name:value` header sent with every push, for a load balancer
 * that gates the endpoint on a header.
 */
export const ENV_HEADER = "CCQA_COVERAGE_HEADER";

/** Absolute path file ids are made relative to. Defaults to `process.cwd()`. */
export const ENV_ROOT = "CCQA_COVERAGE_ROOT";

/**
 * Comma-separated path prefixes (relative to the root) that get instrumented.
 * Defaults to `src`, since instrumenting `node_modules` costs a lot and tells
 * you nothing about the project under test.
 */
export const ENV_INCLUDE = "CCQA_COVERAGE_INCLUDE";

/** Diagnostics to stderr. Never stdout: a preload shares it with its host. */
export const ENV_DEBUG = "CCQA_COVERAGE_DEBUG";

/**
 * `<provider>:<identity>` — who caused a request, for the requests that cannot
 * say which spec they belong to.
 *
 * The application stamps this and nothing else: which spec an identity was
 * acting for at a given instant is decided by the run, which is the only side
 * that knows. Nothing about the mapping is ever sent back here.
 */
const ACTOR_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*:\S{1,200}$/;

/** What one hop carries: the spec it belongs to, or who caused it and when. */
export type CoverageMark = { spec: string } | { tag: string; at: number };

export function parseActorTag(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  return ACTOR_TAG.test(value) ? value : undefined;
}

/** Reads a mark off the wire, refusing anything that is not one of the two shapes. */
export function parseMark(value: unknown): CoverageMark | undefined {
  if (typeof value === "string") {
    const spec = parseSpecId(value);
    return spec === undefined ? undefined : { spec };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { tag, at } = value as { tag?: unknown; at?: unknown };
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const parsed = parseActorTag(typeof tag === "string" ? tag : undefined);
  return parsed === undefined ? undefined : { tag: parsed, at };
}

const SPEC_ID = /^[A-Za-z0-9._\-/]{1,200}$/;

/**
 * Accepts a carrier value only if it looks like an id we wrote.
 *
 * The cookie is client-controlled, so this is the first of two gates: the
 * second is the hub refusing runs it never started.
 */
export function parseSpecId(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (!SPEC_ID.test(value)) return undefined;
  if (value === "1" || value === "true") return undefined;
  return value;
}

export function readCookie(header: string | undefined | null): string | undefined {
  return readKeyed(header, COOKIE_NAME, ";");
}

/** Pulls our key out of a `baggage` header (W3C: `k=v;props,k2=v2`). */
export function readBaggage(header: string | undefined | null): string | undefined {
  return readKeyed(header, BAGGAGE_KEY, ",", ";");
}

/**
 * Both carriers are `key=value` lists; they differ only in what separates the
 * entries, and baggage allowing properties after each value.
 *
 * One function because the decode-and-validate step is the part that matters,
 * and two copies of it would be free to drift into accepting different things.
 */
function readKeyed(
  header: string | undefined | null,
  key: string,
  between: string,
  propertiesAfter?: string,
): string | undefined {
  if (!header) return undefined;
  // Most requests carry neither header; skip the split/loop below for the
  // common case rather than building entries just to find none match.
  if (header.indexOf(key) < 0) return undefined;
  for (const raw of header.split(between)) {
    const entry = propertiesAfter === undefined ? raw : (raw.split(propertiesAfter)[0] ?? "");
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    if (entry.slice(0, eq).trim() !== key) continue;
    try {
      return parseSpecId(decodeURIComponent(entry.slice(eq + 1).trim()));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Adds our key to an existing `baggage` header value, replacing any old one. */
export function writeBaggage(existing: string | undefined | null, specId: string): string {
  const kept = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith(`${BAGGAGE_KEY}=`));
  kept.push(`${BAGGAGE_KEY}=${encodeURIComponent(specId)}`);
  return kept.join(",");
}
