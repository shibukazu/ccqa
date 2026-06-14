import * as log from "./logger.ts";
import { warnStaleBlockArtifacts } from "./stale-blocks.ts";
import { ensureCcqaDir } from "../store/index.ts";
import {
  assertAgentBrowserAvailable,
  AgentBrowserUnavailableError,
  formatAgentBrowserUnavailableMessage,
} from "../runtime/agent-browser-bin.ts";

/**
 * Shared startup steps for every command that drives a real `agent-browser`
 * (currently `ccqa trace` and `ccqa run-nd`):
 *
 *   1. Verify the peer-installed agent-browser binary is reachable. On
 *      failure print the standard guidance and `process.exit(1)`; on
 *      success return the bin directory.
 *   2. Ensure `.ccqa/features/` and `.ccqa/blocks/` exist.
 *   3. Warn about stale per-block artifacts left over from older ccqa
 *      versions.
 *
 * Keeping these in one helper avoids drift between commands' early-exit
 * messaging and means a new agent-browser-using command picks up the same
 * UX automatically.
 */
export async function preflightAgentBrowserCommand(): Promise<void> {
  try {
    log.meta("agent-browser", assertAgentBrowserAvailable());
  } catch (e) {
    if (e instanceof AgentBrowserUnavailableError) {
      log.error(formatAgentBrowserUnavailableMessage());
      process.exit(1);
    }
    throw e;
  }

  await ensureCcqaDir();
  await warnStaleBlockArtifacts();
}
