import {
  DeleteAttestationRequestSchema,
  PutAttestationRequestSchema,
  type Attestation,
  type AttestationResponse,
  type AttestationsResponse,
} from "../../contract/schema.ts";
import { requireSpecTargets } from "../../core/perspectives-specs.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readJsonBody, sendJson } from "../respond.ts";
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
    const [body, head, targets] = await Promise.all([
      readJsonBody(ctx.req, MAX_BODY_BYTES, PutAttestationRequestSchema, "attestation body"),
      storage.deploys.head(scope.project, scope.profile),
      requireSpecTargets(storage.perspectives, scope.project, "what can be attested"),
    ]);
    // Only a spec the perspectives document knows can carry an attestation:
    // /rerun iterates that document, so a key outside it would be accepted,
    // never surface anywhere, and never lapse — write-only junk the store's
    // one-per-spec bound is meant to rule out.
    if (!targets.some((target) => target.key === body.spec)) {
      throw new HttpError(
        400,
        "unknown_spec",
        `spec "${body.spec}" is not in project "${scope.project}"'s perspectives document — ` +
          `attest with the canonical feature/spec key, or push \`ccqa perspectives\` first`,
      );
    }
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
