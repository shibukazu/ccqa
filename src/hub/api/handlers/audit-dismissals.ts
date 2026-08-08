import {
  DeleteAuditDismissalRequestSchema,
  PutAuditDismissalRequestSchema,
  type AuditDismissal,
  type AuditDismissalResponse,
  type AuditDismissalsResponse,
} from "../../contract/schema.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readJsonBody, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/** Far above the largest body `PutAuditDismissalRequestSchema`'s bounds admit. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * GET /api/v1/projects/:project/audit-dismissals — the raw document,
 * whether or not each entry still answers the spec's current finding. No
 * `?profile=`: a finding is about the repository (see `AuditDismissalSchema`).
 */
export function createGetAuditDismissalsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const doc = await storage.auditDismissals.get(project);
    sendJson(ctx.res, 200, { project, specs: doc.specs } satisfies AuditDismissalsResponse);
  };
}

/**
 * PUT /api/v1/projects/:project/audit-dismissals — record that a person
 * judged the spec's current audit finding wrong.
 *
 * The finding being answered is read from the ledger rather than taken from
 * the caller: a dismissal must name the run and the label it answers, and
 * only the hub knows which finding is current. A spec with no open finding is
 * a 400 — there is nothing to dismiss, and accepting it would write a record
 * that never applies to anything.
 *
 * The guard stops there on purpose. `/rerun` applies a dismissal only while
 * the audit is also *current* for the profile being asked about, and that is
 * a per-profile question this endpoint has no profile to ask it of (a finding
 * is about the repository, so the dismissal is project-scoped). A dismissal
 * written while a deploy has overtaken the audit is harmless: the next audit
 * supersedes the finding, and the record with it.
 */
export function createPutAuditDismissalHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const [body, ledger] = await Promise.all([
      readJsonBody(ctx.req, MAX_BODY_BYTES, PutAuditDismissalRequestSchema, "dismissal body"),
      storage.driftLedger.getMerged(project),
    ]);

    const entry = ledger.specs[body.spec];
    if (!entry || entry.label === null) {
      throw new HttpError(
        400,
        "no_open_finding",
        `spec "${body.spec}" has no open audit finding in project "${project}" — there is nothing to dismiss`,
      );
    }

    const dismissal: AuditDismissal = {
      by: body.by,
      at: new Date().toISOString(),
      note: body.note,
      auditRunId: entry.runId,
      label: entry.label,
      headline: entry.headline ?? "",
    };
    await storage.auditDismissals.update(project, (current) => ({
      specs: { ...current.specs, [body.spec]: dismissal },
    }));
    sendJson(ctx.res, 200, { project, spec: body.spec, dismissal } satisfies AuditDismissalResponse);
  };
}

/**
 * DELETE /api/v1/projects/:project/audit-dismissals — withdraw a dismissal,
 * putting the audit's finding back in force. Deleting one that does not exist
 * is 200: the caller asked for its absence, and it is absent.
 */
export function createDeleteAuditDismissalHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const body = await readJsonBody(
      ctx.req,
      MAX_BODY_BYTES,
      DeleteAuditDismissalRequestSchema,
      "dismissal body",
    );
    await storage.auditDismissals.update(project, (current) => {
      const { [body.spec]: _, ...rest } = current.specs;
      return { specs: rest };
    });
    sendJson(ctx.res, 200, { removed: body.spec });
  };
}
