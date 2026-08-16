import { spawnAB } from "../../runtime/spawn-ab.ts";
import type { CdpBrowserHandle, CdpEndpointContext } from "../types.ts";

/**
 * Where the agent-browser target's browser comes from under `--coverage`.
 *
 * agent-browser owns its browser but hands out the keys on request:
 * `get cdp-url` answers with the browser-level DevTools socket. The daemon
 * launches a session's browser lazily, so an `open about:blank` forces it up
 * first — into a session the caller already owns, before the agent starts
 * driving it. Auth-state restored into the session afterwards lands in a warm
 * browser, which is the same shape as the executor's mid-run recovery path.
 *
 * `dispose` does nothing on purpose: the session's lifecycle belongs to the
 * caller (the live runner closes it after the engine has stopped), and
 * closing somebody else's session from here would tear the browser down
 * while its owner still thinks it is driving it.
 */
export async function acquireAgentBrowserEndpoint(
  ctx: CdpEndpointContext,
): Promise<CdpBrowserHandle> {
  const session = ctx.driverSession;
  if (session === undefined) {
    throw new Error(
      "the agent-browser target's browser lives in a driver session, and none was supplied",
    );
  }
  const warm = spawnAB(["--session", session, "open", "about:blank"]);
  if (warm.status !== 0) {
    throw new Error(`could not start the session's browser: ${warm.stderr || warm.stdout}`);
  }
  const answer = spawnAB(["--session", session, "get", "cdp-url"]);
  const cdpUrl = answer.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (answer.status !== 0 || !/^wss?:\/\//.test(cdpUrl)) {
    throw new Error(
      `agent-browser did not answer \`get cdp-url\` for session ${session}: ${answer.stderr || answer.stdout}`,
    );
  }
  return { cdpUrl, dispose: async () => {} };
}
