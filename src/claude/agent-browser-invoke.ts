import { pathWithAgentBrowserShim } from "../runtime/agent-browser-bin.ts";
import type { ClaudeInvokeOptions } from "./invoke.ts";

/**
 * Build the env + allowed-tools fields every agent-browser-driven Claude
 * invocation needs. Currently used by `ccqa trace` and `ccqa run-nd`:
 *
 * - `AGENT_BROWSER_SESSION` so the model can read which session to pass
 * - `PATH` prepended with the peer-installed agent-browser shim dir, so
 *   `agent-browser ...` resolves without a global install
 * - allowed tools = Bash + the read-only source-inspection trio. Trace and
 *   run-nd both expose `Read`/`Grep`/`Glob` so the model can look up
 *   selectors or routing in the consuming app's source.
 *
 * Caller mixes the returned object into the `ClaudeInvokeOptions` it builds.
 * Kept as plain partial-options builder (not a wrapper around
 * `invokeClaudeStreaming`) because trace and run-nd need different
 * `onEvent` callbacks and constraint postures around it.
 */
export function agentBrowserInvokeBase(sessionName: string): Pick<ClaudeInvokeOptions, "allowedTools" | "env"> {
  return {
    allowedTools: ["Bash(*)", "Read", "Grep", "Glob"],
    env: {
      AGENT_BROWSER_SESSION: sessionName,
      PATH: pathWithAgentBrowserShim(process.env["PATH"]),
    },
  };
}
