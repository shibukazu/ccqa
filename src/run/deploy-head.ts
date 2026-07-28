import type { HubContext } from "../cli/hub-conn.ts";
import type { HubClient } from "../hub-client/index.ts";

/**
 * The commit a profile's environment is currently running, per the hub's
 * deploy log — its newest entry, or null when nothing has been recorded.
 */
export async function deployHeadSha(
  hub: HubClient,
  project: string,
  profile: string,
): Promise<string | null> {
  const { entries } = await hub.getDeployLog(project, { profile, limit: 1 });
  return entries[entries.length - 1]?.sha ?? null;
}

/**
 * The commit the profile's environment was running when this run started.
 *
 * Captured before any spec executes and asserted on both push paths
 * (`?deployedSha=` on `POST /runs` via `ccqa hub push`, and on `POST
 * /runs/open` for `--report-to-hub`). Left to itself the hub reads its own
 * deploy-log head when the call lands — after the whole run for a single-shot
 * push, after the deterministic phase for an incremental one — so a deploy
 * landing in that window would be recorded as the run's baseline and
 * under-report what needs re-running later. Asserting the earlier commit errs
 * the other way: a spec that straddled a deploy is simply selected again.
 *
 * Best-effort by design (hence `try`): no hub, no profile, no deploy log, or a
 * hub too old to serve one all leave the run unattributed, exactly as before.
 */
export async function tryDeployHeadSha(
  hubCtx: HubContext,
  profile: string,
): Promise<string | null> {
  try {
    return await deployHeadSha(hubCtx.hub, hubCtx.project, profile);
  } catch {
    return null;
  }
}
