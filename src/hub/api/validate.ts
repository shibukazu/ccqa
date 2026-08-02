import { HttpError } from "./respond.ts";

/**
 * Validators for the request parameters handlers read straight off the wire:
 * the URL path parameters that flow into the storage layer's file path
 * construction (secret store scope/name, artifact relative paths), and the
 * query params bounding a listing's time window.
 *
 * Router params come from `decodeURIComponent`-ed path segments, so a client
 * can put `..`, `/`, or `\` in them — the path validators below reject
 * anything that could escape the intended directory before it ever reaches
 * disk I/O.
 */

// A bare name: letters, digits, '.', '_', '-'. Excludes path separators and
// a leading '.' (which also rules out ".." and ".").
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate a single URL path parameter (e.g. `:profile`, `:name`) as a bare name. Throws 400 if unsafe. */
export function requireSafeSegment(value: string, paramName: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    !SAFE_SEGMENT.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new HttpError(
      400,
      "invalid_param",
      `invalid ${paramName}: must be a bare name (letters, digits, '.', '_', '-'; no path separators or '..')`,
    );
  }
  return value;
}

/**
 * The `?profile=` query param, defaulting to "default". Shared by every
 * profile-scoped route so the default and the validation rule have one home.
 */
export function requireProfileParam(url: URL): string {
  return requireSafeSegment(url.searchParams.get("profile") ?? "default", "profile");
}

/**
 * The `?since=`/`?until=` window a listing takes, in the shape its store's
 * `list` takes it. Half-open on purpose: a caller asking for one day passes
 * that day's start and the next day's start, and no record is counted twice
 * at a boundary.
 */
export function requireWindowParams(url: URL): { since?: string; until?: string } {
  const since = requireInstant(url.searchParams.get("since"), "since");
  const until = requireInstant(url.searchParams.get("until"), "until");
  return { ...(since ? { since } : {}), ...(until ? { until } : {}) };
}

/** Rejected rather than ignored: a typo would otherwise read as "nothing that day". */
function requireInstant(raw: string | null, name: string): string | null {
  if (raw === null || raw === "") return null;
  if (Number.isNaN(Date.parse(raw))) {
    throw new HttpError(400, "invalid_param", `invalid ${name}: must be an ISO-8601 instant`);
  }
  return raw;
}

/** Validate a `*path`-captured relative path (multiple segments allowed) as safe to join under a root dir. Throws 400 if unsafe. */
export function requireSafeRelPath(relPath: string, paramName: string): string {
  const segments = relPath.split("/");
  if (
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    relPath.includes("\\") ||
    segments.includes("..") ||
    segments.includes(".")
  ) {
    throw new HttpError(400, "invalid_param", `invalid ${paramName}: must be a relative path without '..' segments`);
  }
  return relPath;
}
