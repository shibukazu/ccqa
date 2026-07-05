import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

/**
 * GET /api/v1/projects — every project name known to the hub. Projects are
 * implicit (created by pushing a run or storing a secret/prompt under a name,
 * gone when nothing references them), so the list is the union of what the
 * runs, secret, and prompt stores have seen. Feeds the UI's project selector.
 */
export function createListProjectsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const [runs, sessions, variables, prompts] = await Promise.all([
      storage.runs.listProjects(),
      storage.sessions.listProjects(),
      storage.variables.listProjects(),
      storage.prompts.listProjects(),
    ]);
    const projects = [...new Set([...runs, ...sessions, ...variables, ...prompts])].sort();
    sendJson(ctx.res, 200, { projects });
  };
}

/**
 * GET /api/v1/projects/:project/profiles — the profile names under a project.
 * A profile scopes only secrets (sessions + variables — a profile is a set of
 * env vars); prompts are project-wide and runs are cross-profile, so this is
 * the union of what the session and variable stores have. "default" is always
 * offered even when empty, so a first secret has somewhere to go. Feeds the
 * Secrets tab's profile selector.
 */
export function createListProfilesHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const [sessions, variables] = await Promise.all([
      storage.sessions.listProfiles(project),
      storage.variables.listProfiles(project),
    ]);
    const profiles = [...new Set(["default", ...sessions, ...variables])].sort();
    sendJson(ctx.res, 200, { profiles });
  };
}
