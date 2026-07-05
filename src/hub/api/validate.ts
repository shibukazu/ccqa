import { HttpError } from "./respond.ts";

/**
 * Validators for URL path parameters that flow into the storage layer's file
 * path construction (secret store scope/name, artifact relative paths).
 * Router params come from `decodeURIComponent`-ed path segments, so a client
 * can put `..`, `/`, or `\` in them — these guards reject anything that
 * could escape the intended directory before it ever reaches disk I/O.
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
