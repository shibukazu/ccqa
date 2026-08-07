import {
  DeleteAttestationRequestSchema,
  PutAttestationRequestSchema,
  type Attestation,
  type AttestationResponse,
  type AttestationsResponse,
} from "../../contract/schema.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { readJsonBody, sendJson } from "../respond.ts";
import { requireProfileParam, requireSafeSegment } from "../validate.ts";

/** Far above the largest body `PutAttestationRequestSchema`'s bounds admit. */
const MAX_BODY_BYTES = 64 * 1024;

function requireScope(ctx: RouteContext): { project: string; profile: string } {
  return {
    project: requireSafeSegment(ctx.params.project!, "project"),
    profile: requireProfileParam(ctx.url),
  };
}

/**
 * GET /api/v1/projects/:project/attestations?profile= — the raw document,
 * standing and lapsed alike. Whether one still covers its spec is `/rerun`'s
 * answer; this exists so a lapsed attestation can still be found and revoked.
 */
export function createGetAttestationsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const doc = await storage.attestations.get(scope.project, scope.profile);
    sendJson(ctx.res, 200, { ...scope, specs: doc.specs } satisfies AttestationsResponse);
  };
}

/**
 * PUT /api/v1/projects/:project/attestations?profile= — record that a person
 * checked a spec by hand. The hub stamps the time and the profile's deploy
 * head: the anchor must be what the hub knows was deployed at this moment,
 * not what the caller believes. Replaces any previous attestation for the
 * spec.
 */
export function createPutAttestationHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, PutAttestationRequestSchema, "attestation body");
    const head = await storage.deploys.head(scope.project, scope.profile);
    const attestation: Attestation = {
      by: body.by,
      at: new Date().toISOString(),
      ...(body.note !== undefined ? { note: body.note } : {}),
      deployedSha: head?.sha ?? null,
    };
    await storage.attestations.update(scope.project, scope.profile, (current) => ({
      specs: { ...current.specs, [body.spec]: attestation },
    }));
    sendJson(ctx.res, 200, { ...scope, spec: body.spec, attestation } satisfies AttestationResponse);
  };
}

/**
 * DELETE /api/v1/projects/:project/attestations?profile= — revoke a spec's
 * attestation. Deleting one that does not exist is 200 like deleting one that
 * does: the caller asked for its absence, and it is absent.
 */
export function createDeleteAttestationHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const scope = requireScope(ctx);
    const body = await readJsonBody(ctx.req, MAX_BODY_BYTES, DeleteAttestationRequestSchema, "attestation body");
    await storage.attestations.update(scope.project, scope.profile, (current) => {
      const { [body.spec]: _, ...rest } = current.specs;
      return { specs: rest };
    });
    sendJson(ctx.res, 200, { removed: body.spec });
  };
}
