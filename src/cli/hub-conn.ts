import { createHubClient, HubApiError, type HubClient } from "../hub-client/index.ts";
import { resolveProjectOrThrow } from "./resolve-project.ts";
import * as log from "./logger.ts";

/**
 * Single source of truth for hub connection flags/env, shared by every
 * command that talks to a hub (`hub`, and later `run`/`record`).
 */

export const hubUrlOption = ["--hub-url <url>", "ccqa hub base URL (or CCQA_HUB_URL)."] as const;
export const hubTokenOption = ["--hub-token <token>", "ccqa hub bearer token (or CCQA_HUB_TOKEN)."] as const;
export const hubHeaderOption = [
  "--hub-header <header>",
  "Extra header sent with every hub request, as \"key:value\" (or CCQA_HUB_HEADER). Repeatable. " +
    "For infra that gates the hub behind a header check (e.g. a load balancer bypass rule).",
  collectHubHeader,
  [] as string[],
] as const;

export interface HubConnOptions {
  hubUrl?: string;
  hubToken?: string;
  hubHeader?: string[];
}

/** commander `--hub-header` accumulator: collects repeated flags into an array. */
function collectHubHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parse `"key:value"` entries (from `--hub-header`, repeatable) into a
 * headers map. The value may itself contain `:` (e.g. a URL), so only the
 * first colon is treated as the separator. Throws on an entry with no colon.
 */
export function parseHubHeaders(entries: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of entries) {
    const i = entry.indexOf(":");
    if (i < 0) {
      throw new Error(`invalid --hub-header (expected "key:value"): ${entry}`);
    }
    const key = entry.slice(0, i).trim();
    const value = entry.slice(i + 1).trim();
    if (!key) {
      throw new Error(`invalid --hub-header (expected "key:value"): ${entry}`);
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Resolve custom hub headers from flags, falling back to `CCQA_HUB_HEADER`
 * (a single `"key:value"` entry) when no `--hub-header` flag was given.
 * CI setups typically pass exactly one gateway header via env; `--hub-header`
 * is repeatable for the (rarer) local/multi-header case.
 */
function resolveHubHeaders(hubHeader?: string[]): Record<string, string> | undefined {
  if (hubHeader && hubHeader.length > 0) return parseHubHeaders(hubHeader);
  const envHeader = process.env.CCQA_HUB_HEADER;
  if (envHeader) return parseHubHeaders([envHeader]);
  return undefined;
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
  const headers = resolveHubHeaders(opts.hubHeader);
  return createHubClient({ baseUrl: baseUrl.replace(/\/+$/, ""), token, ...(headers ? { headers } : {}) });
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
  opts: HubConnOptions & { project?: string; cwd?: string },
): HubContext | null {
  const hub = resolveHubClient(opts);
  if (!hub) return null;
  const project = resolveProjectOrThrow(opts.project, opts.cwd ?? process.cwd());
  return { hub, project };
}

/**
 * Wrap a subcommand action so a `HubApiError` (hub request failed, e.g. a
 * 503 when the hub has no encryption key configured) prints a clean message
 * and exits 2, instead of surfacing as an unhandled rejection with a stack
 * trace.
 */
export function withHubErrors<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof HubApiError) {
        log.error(`hub request failed (${err.status} ${err.code}): ${err.message}`);
        process.exit(2);
      }
      throw err;
    }
  };
}
