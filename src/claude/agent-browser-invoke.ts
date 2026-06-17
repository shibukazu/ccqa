import { pathWithAgentBrowserShim } from "../runtime/agent-browser-bin.ts";
import type { ClaudeInvokeOptions } from "./invoke.ts";

/**
 * Build the env + allowed-tools fields every agent-browser-driven Claude
 * invocation needs. Currently used by `ccqa record` (trace) and `ccqa run`
 * (live mode):
 *
 * - One of `AGENT_BROWSER_SESSION` (ephemeral, isolated session — default)
 *   or `AGENT_BROWSER_SESSION_NAME` (sticky, cookies + localStorage
 *   auto-saved by name under `~/.agent-browser/sessions/` and restored on
 *   the next run). Sticky mode is opt-in via spec.yaml's `sessionName:`
 *   field so device-trust gates (Slack "we don't recognize this browser",
 *   MFA prompts, …) can be cleared once and skipped thereafter.
 * - `PATH` prepended with the peer-installed agent-browser shim dir, so
 *   `agent-browser ...` resolves without a global install
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
  /**
   * `"sticky"` opts into agent-browser's `--session-name` auto-save/restore
   * (cookies + localStorage persist by name across runs); `"ephemeral"` uses
   * `--session` (state is wiped when the browser closes). Defaults to
   * `"ephemeral"` so existing callers keep their current isolation.
   */
  sessionMode?: "ephemeral" | "sticky";
}

export function agentBrowserInvokeBase(
  input: AgentBrowserInvokeBaseInput,
): Pick<ClaudeInvokeOptions, "allowedTools" | "env"> {
  // Pick the matching env var so a Bash `agent-browser ...` without an
  // explicit `--session(-name)` flag inherits the right behaviour. We do not
  // set both at once: agent-browser would treat that as a conflict.
  const sessionKey = input.sessionMode === "sticky"
    ? "AGENT_BROWSER_SESSION_NAME"
    : "AGENT_BROWSER_SESSION";
  return {
    allowedTools: ["Bash(*)", "Read", "Grep", "Glob"],
    env: {
      [sessionKey]: input.sessionName,
      CCQA_RUN_ID: input.runId,
      PATH: pathWithAgentBrowserShim(process.env["PATH"]),
    },
  };
}
