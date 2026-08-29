import { resolveAgentBrowserBin } from "../../runtime/agent-browser-bin.ts";
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
  // Re-asked rather than remembered: the daemon relaunches a session's browser
  // on a port the OS picks, and the address handed out here dies with the old one.
  return {
    cdpUrl: askCdpUrl(session),
    currentCdpUrl: () => askCdpUrlSoon(session),
    dispose: async () => {},
  };
}

/**
 * The same question on a short leash. Its caller is racing its own backoff
 * between reconnect attempts, so an answer that arrives after the budget is
 * spent is worth less than no answer: `spawnAB` would sit through a 30s EAGAIN
 * retry and a 35s hard timeout, which is the whole reconnect window several
 * times over.
 */
const CDP_URL_TIMEOUT_MS = 2_000;

async function askCdpUrlSoon(session: string): Promise<string> {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const { stdout } = await promisify(execFile)(
    resolveAgentBrowserBin(),
    ["--session", session, "get", "cdp-url"],
    { timeout: CDP_URL_TIMEOUT_MS, encoding: "utf8" },
  );
  const cdpUrl = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!/^wss?:\/\//.test(cdpUrl)) {
    throw new Error(`agent-browser answered no cdp-url for session ${session}`);
  }
  return cdpUrl;
}

function askCdpUrl(session: string): string {
  const answer = spawnAB(["--session", session, "get", "cdp-url"]);
  const cdpUrl = answer.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (answer.status !== 0 || !/^wss?:\/\//.test(cdpUrl)) {
    throw new Error(
      `agent-browser did not answer \`get cdp-url\` for session ${session}: ${answer.stderr || answer.stdout}`,
    );
  }
  return cdpUrl;
}
