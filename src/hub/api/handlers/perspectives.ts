import type { PerspectivesStore } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendBytes } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

const MAX_PERSPECTIVES_BODY_BYTES = 1024 * 1024;

export interface PerspectivesHandlerConfig {
  store: PerspectivesStore;
}

/** Validate the `:project` route param (perspectives are project-scoped, one document per project). */
function requireProject(ctx: RouteContext): string {
  return requireSafeSegment(ctx.params.project!, "project");
}

/**
 * PUT /api/v1/projects/:project/perspectives — body is the perspectives
 * document as JSON. Schema validation is the CLI's job (it Zod-validates
 * before pushing); the hub only rejects bodies that aren't a JSON object,
 * so the UI can always JSON.parse what it reads back.
 */
export function createPutPerspectivesHandler(config: PerspectivesHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const body = await readBody(ctx.req, MAX_PERSPECTIVES_BODY_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_body", "perspectives body must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_body", "perspectives body must be a JSON object");
    }
    await config.store.put(project, new Uint8Array(body));
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** GET /api/v1/projects/:project/perspectives — the stored document, or 404. */
export function createGetPerspectivesHandler(config: PerspectivesHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const stored = await config.store.get(project);
    if (!stored) {
      throw new HttpError(404, "not_found", `no perspectives stored for project "${project}"`);
    }
    sendBytes(ctx.res, 200, stored, "application/json; charset=utf-8");
  };
}

/** DELETE /api/v1/projects/:project/perspectives */
export function createDeletePerspectivesHandler(config: PerspectivesHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    await config.store.delete(project);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

const MAX_NOTE_BODY_BYTES = 64 * 1024;

/** The note-edit body shape (see createPatchPerspectivesNoteHandler). */
interface NotePatch {
  feature: string;
  spec: string;
  note: string;
}

function parseNotePatch(body: Buffer): NotePatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_body", "note patch must be valid JSON");
  }
  const rec = parsed as { feature?: unknown; spec?: unknown; note?: unknown };
  if (
    typeof rec?.feature !== "string" || rec.feature.length === 0 ||
    typeof rec.spec !== "string" || rec.spec.length === 0 ||
    typeof rec.note !== "string"
  ) {
    throw new HttpError(400, "invalid_body", "note patch must be { feature, spec, note } with string values");
  }
  return { feature: rec.feature, spec: rec.spec, note: rec.note };
}

/**
 * PATCH /api/v1/projects/:project/perspectives — the hub UI's note editing.
 * Body: `{ feature, spec, note }`; an empty `note` clears the field. The
 * note is the only human-authored field in the document, and this is its
 * only write path now that the document never lives in the consuming repo.
 * Runs as a serialized read-modify-write so an edit can't clobber (or be
 * clobbered by) a concurrent one.
 */
export function createPatchPerspectivesNoteHandler(config: PerspectivesHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const patch = parseNotePatch(await readBody(ctx.req, MAX_NOTE_BODY_BYTES));
    await config.store.update(project, (current) => {
      if (current === null) {
        throw new HttpError(404, "not_found", `no perspectives stored for project "${project}"`);
      }
      const doc = current as { features?: { featureName?: string; specs?: { specName?: string; note?: string }[] }[] };
      const specEntry = doc.features
        ?.find((f) => f?.featureName === patch.feature)
        ?.specs?.find((s) => s?.specName === patch.spec);
      if (!specEntry) {
        throw new HttpError(404, "not_found", `no spec "${patch.feature}/${patch.spec}" in the perspectives document`);
      }
      if (patch.note === "") {
        delete specEntry.note;
      } else {
        specEntry.note = patch.note;
      }
      return current;
    });
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}
