import { createHubClient, type HubClient } from "../hub-client/index.ts";
import { resolveProjectOrThrow } from "./resolve-project.ts";

/**
 * Single source of truth for hub connection flags/env, shared by every
 * command that talks to a hub (`hub`, and later `run`/`record`).
 */

export const hubUrlOption = ["--hub-url <url>", "ccqa hub base URL (or CCQA_HUB_URL)."] as const;
export const hubTokenOption = ["--hub-token <token>", "ccqa hub bearer token (or CCQA_HUB_TOKEN)."] as const;

export interface HubConnOptions {
  hubUrl?: string;
  hubToken?: string;
}

/** Thrown by `requireHubClient` when the URL and/or token can't be resolved from flags/env. */
export class HubConnectionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve a hub client from flags / env. Returns `null` (never throws/exits)
 * when either the URL or the token is missing — callers that treat the hub
 * as optional can fall back; callers that require it should use
 * `requireHubClient` instead.
 */
export function resolveHubClient(opts: HubConnOptions): HubClient | null {
  const baseUrl = opts.hubUrl ?? process.env.CCQA_HUB_URL;
  const token = opts.hubToken ?? process.env.CCQA_HUB_TOKEN;
  if (!baseUrl || !token) return null;
  return createHubClient({ baseUrl: baseUrl.replace(/\/+$/, ""), token });
}

/** Same as `resolveHubClient`, but throws `HubConnectionError` instead of returning `null`. */
export function requireHubClient(opts: HubConnOptions): HubClient {
  const client = resolveHubClient(opts);
  if (!client) {
    throw new HubConnectionError("hub URL and token are required (--hub-url/--hub-token or CCQA_HUB_URL/CCQA_HUB_TOKEN)");
  }
  return client;
}

/**
 * A resolved hub connection + the project scope to use with it. Bundles the
 * two values every hub-backed *best-effort* lookup needs (custom prompt,
 * prompt bundle) so callers stop passing `hubClient`/`project` separately
 * and re-deriving the `hubClient && project` guard at each call site.
 *
 * Deliberately scoped to best-effort hub lookups only — `--profile`
 * resolution has different error semantics (a missing hub there is a hard
 * failure, not a "degrade to null" case) and keeps resolving its own
 * client/project instead of going through this type.
 */
export interface HubContext {
  hub: HubClient;
  project: string;
}

/**
 * Resolve a `HubContext` from run/record options: `null` when no hub is
 * configured (URL/token absent) — callers degrade to local/best-effort
 * behaviour in that case. When a hub *is* configured but the project name
 * can't be resolved/validated, this throws (`ProjectNameError`, from
 * `resolveProjectOrThrow`) rather than silently degrading — that's a usage
 * error, and the caller decides how to handle it (map to a run-stopping
 * error, or catch and degrade to `null` on a best-effort path).
 */
export function resolveHubContext(
  opts: { hubUrl?: string; hubToken?: string; project?: string; cwd?: string },
): HubContext | null {
  const hub = resolveHubClient(opts);
  if (!hub) return null;
  const project = resolveProjectOrThrow(opts.project, opts.cwd ?? process.cwd());
  return { hub, project };
}
