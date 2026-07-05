import { PutVariableRequestSchema } from "../../contract/schema.ts";
import { decodeEncryptedBlob, decrypt, encodeEncryptedBlob, encrypt } from "../../core/crypto.ts";
import type { SecretScope, SecretStore } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendBytes, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

const MAX_SECRET_BODY_BYTES = 4 * 1024 * 1024;

export interface SecretHandlerConfig {
  store: SecretStore;
  encryptionKey: Buffer | null;
}

function requireKey(config: SecretHandlerConfig): Buffer {
  if (!config.encryptionKey) {
    throw new HttpError(503, "encryption_not_configured", "CCQA_HUB_ENCRYPTION_KEY is not set on this hub");
  }
  return config.encryptionKey;
}

/** Validate the `:project`/`:profile` route params into a store scope. */
function requireScope(ctx: RouteContext): SecretScope {
  return {
    project: requireSafeSegment(ctx.params.project!, "project"),
    profile: requireSafeSegment(ctx.params.profile!, "profile"),
  };
}

/** PUT /api/v1/projects/:project/sessions/:profile/:name — body is the raw agent-browser storage-state JSON. */
export function createPutSessionHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const scope = requireScope(ctx);
    const name = requireSafeSegment(ctx.params.name!, "name");
    const body = await readBody(ctx.req, MAX_SECRET_BODY_BYTES);
    const blob = encodeEncryptedBlob(encrypt(new Uint8Array(body), key));
    await config.store.put(scope, name, blob);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** GET /api/v1/projects/:project/sessions/:profile — metadata only (names + timestamps). */
export function createListSessionsHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const entries = await config.store.list(scope);
    sendJson(ctx.res, 200, {
      sessions: entries.map((e) => ({ name: e.name, updatedAt: e.updatedAt })),
    });
  };
}

/**
 * GET /api/v1/projects/:project/sessions/:profile/:name — the decrypted
 * storage-state JSON. Any token holder can read stored sessions (fetched by
 * `ccqa run` at execution time); see docs/hub.md on why the "write-only"
 * guarantee is traded for a single CI secret.
 */
export function createGetSessionHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const scope = requireScope(ctx);
    const name = requireSafeSegment(ctx.params.name!, "name");
    const stored = await config.store.get(scope, name);
    if (!stored) throw new HttpError(404, "not_found", `session "${name}" not found for ${scope.project}/${scope.profile}`);
    const plain = decrypt(decodeEncryptedBlob(stored.blob), key);
    sendBytes(ctx.res, 200, plain, "application/json; charset=utf-8");
  };
}

/** DELETE /api/v1/projects/:project/sessions/:profile/:name */
export function createDeleteSessionHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const name = requireSafeSegment(ctx.params.name!, "name");
    await config.store.delete(scope, name);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** PUT /api/v1/projects/:project/variables/:profile/:name */
export function createPutVariableHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const key = requireKey(config);
    const scope = requireScope(ctx);
    const name = requireSafeSegment(ctx.params.name!, "name");
    const body = await readBody(ctx.req, MAX_SECRET_BODY_BYTES);
    const parsed = PutVariableRequestSchema.safeParse(JSON.parse(body.toString("utf8") || "{}"));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid request body");
    }
    const blob = encodeEncryptedBlob(encrypt(new TextEncoder().encode(parsed.data.value), key));
    await config.store.put(scope, name, blob, { sensitive: parsed.data.sensitive });
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/**
 * GET /api/v1/projects/:project/variables/:profile — variable metadata. By
 * default sensitive values are omitted (so `ccqa hub var ls` doesn't print
 * secrets). With `?include=values` every value is decrypted and returned
 * (used by `ccqa run` when fetching secrets); any token holder can then read
 * them, which requires the encryption key to be configured.
 */
export function createListVariablesHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const includeValues = ctx.url.searchParams.get("include") === "values";
    const key = includeValues ? requireKey(config) : config.encryptionKey;

    const entries = await config.store.list(scope);
    const variables = await Promise.all(
      entries.map(async (e) => {
        const sensitive = e.meta.sensitive === true;
        const wantValue = key !== null && (includeValues || !sensitive);
        if (!wantValue) return { name: e.name, sensitive, updatedAt: e.updatedAt };
        // Decrypt per-variable: one corrupt/rotated blob must not fail the whole
        // response (a run fetching many keys would otherwise abort on a
        // single bad entry). Omit the value for the failing one and log which.
        try {
          const stored = await config.store.get(scope, e.name);
          const value = stored ? Buffer.from(decrypt(decodeEncryptedBlob(stored.blob), key!)).toString("utf8") : undefined;
          return { name: e.name, sensitive, updatedAt: e.updatedAt, ...(value !== undefined ? { value } : {}) };
        } catch (err) {
          console.warn(`hub: could not decrypt variable "${e.name}" (${scope.project}/${scope.profile}): ${err instanceof Error ? err.message : String(err)}`);
          return { name: e.name, sensitive, updatedAt: e.updatedAt };
        }
      }),
    );
    sendJson(ctx.res, 200, { variables });
  };
}

/** DELETE /api/v1/projects/:project/variables/:profile/:name */
export function createDeleteVariableHandler(config: SecretHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const name = requireSafeSegment(ctx.params.name!, "name");
    await config.store.delete(scope, name);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}
