import type { PromptStore } from "../../core/storage/types.ts";
import { isPromptName, type PromptName, promptKind } from "../../../prompts/prompt-names.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendBytes, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

const MAX_PROMPT_BODY_BYTES = 256 * 1024;

export interface PromptHandlerConfig {
  store: PromptStore;
}

/** Validate the `:project` route param (prompts are project-scoped, not per-profile). */
function requireProject(ctx: RouteContext): string {
  return requireSafeSegment(ctx.params.project!, "project");
}

/**
 * Prompt names are a closed set (`PromptName`). Beyond the traversal check, the
 * name must be one we recognise — keeping the namespace fixed is what lets the
 * UI and triage-learning jobs rely on the known five.
 */
function requirePromptName(ctx: RouteContext): PromptName {
  const name = requireSafeSegment(ctx.params.name!, "name");
  if (!isPromptName(name)) {
    throw new HttpError(400, "invalid_name", `unknown prompt name "${name}"`);
  }
  return name;
}

/**
 * Derive stored meta from the body. For the custom prompt, pull a few fields out of
 * its JSON so listings can show them without fetching the body; if it isn't
 * valid JSON we still store it (validation is the learn/run side's job) and
 * just record the kind.
 */
function metaFor(name: PromptName, body: Buffer): Record<string, unknown> {
  const kind = promptKind(name);
  if (kind !== "custom-prompt") return { kind };
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return {
      kind,
      ...(typeof parsed?.customPromptVersion === "string" ? { customPromptVersion: parsed.customPromptVersion } : {}),
      ...(typeof parsed?.basePromptVersion === "string" ? { basePromptVersion: parsed.basePromptVersion } : {}),
    };
  } catch {
    return { kind };
  }
}

/** PUT /api/v1/projects/:project/prompts/:name — body is Markdown (guidance) or custom prompt JSON. */
export function createPutPromptHandler(config: PromptHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const name = requirePromptName(ctx);
    const body = await readBody(ctx.req, MAX_PROMPT_BODY_BYTES);
    await config.store.put(project, name, new Uint8Array(body), metaFor(name, body));
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}

/** GET /api/v1/projects/:project/prompts — names + kinds + timestamps (no bodies). */
export function createListPromptsHandler(config: PromptHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const entries = await config.store.list(project);
    sendJson(ctx.res, 200, {
      prompts: entries.map((e) => ({
        name: e.name,
        kind: (e.meta.kind as string) ?? "guidance",
        updatedAt: e.updatedAt,
        meta: e.meta,
      })),
    });
  };
}

/** GET /api/v1/projects/:project/prompts/:name — the raw prompt body, or 404. */
export function createGetPromptHandler(config: PromptHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const name = requirePromptName(ctx);
    const stored = await config.store.get(project, name);
    if (!stored) throw new HttpError(404, "not_found", `prompt "${name}" not found for project "${project}"`);
    const contentType = promptKind(name) === "custom-prompt"
      ? "application/json; charset=utf-8"
      : "text/markdown; charset=utf-8";
    sendBytes(ctx.res, 200, stored.blob, contentType);
  };
}

/** DELETE /api/v1/projects/:project/prompts/:name */
export function createDeletePromptHandler(config: PromptHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireProject(ctx);
    const name = requirePromptName(ctx);
    await config.store.delete(project, name);
    ctx.res.statusCode = 204;
    ctx.res.end();
  };
}
