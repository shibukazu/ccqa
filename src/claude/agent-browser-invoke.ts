import { pathWithAgentBrowserShim } from "../runtime/agent-browser-bin.ts";
import type { ClaudeInvokeOptions } from "./invoke.ts";

/**
 * Build the env + allowed-tools fields every agent-browser-driven Claude
 * invocation needs. Currently used by `ccqa record` (trace) and `ccqa run`
 * (live mode):
 *
 * - `AGENT_BROWSER_SESSION` — ephemeral session name. Each run gets a fresh
 *   id so cookies / localStorage from previous runs do not bleed across.
 *   ccqa never opts into agent-browser's auto-save/restore (`--session-name`)
 *   mode: state lives only inside the run's Chrome process and disappears
 *   when it closes.
 * - `PATH` prepended with the peer-installed agent-browser shim dir, so
 *   `agent-browser ...` resolves without a global install.
 * - `CCQA_RUN_ID` so specs can reference a unique-per-run id (e.g. embed it
 *   in created content names) without the consuming project having to set
 *   one in `.env`. Always set; passes through to any Bash a spec runs.
 * - allowed tools = Bash + the read-only source-inspection trio. Trace and
 *   live both expose `Read`/`Grep`/`Glob` so the model can look up
 *   selectors or routing in the consuming app's source.
 *
 * Caller mixes the returned object into the `ClaudeInvokeOptions` it builds.
 * Kept as plain partial-options builder (not a wrapper around
 * `invokeClaudeStreaming`) because trace and live need different
 * `onEvent` callbacks and constraint postures around it.
 */
export interface AgentBrowserInvokeBaseInput {
  sessionName: string;
  /**
   * Stable id for the current run. Exposed to the model as `CCQA_RUN_ID`.
   * Use `buildRunId()` (live) or `generateSessionName()` slug (trace).
   */
  runId: string;
}

export function agentBrowserInvokeBase(
  input: AgentBrowserInvokeBaseInput,
): Pick<ClaudeInvokeOptions, "allowedTools" | "env"> {
  const env: Record<string, string> = {
    AGENT_BROWSER_SESSION: input.sessionName,
    CCQA_RUN_ID: input.runId,
    PATH: pathWithAgentBrowserShim(process.env["PATH"]),
  };
  return {
    allowedTools: ["Bash(*)", "Read", "Grep", "Glob"],
    env,
  };
}
