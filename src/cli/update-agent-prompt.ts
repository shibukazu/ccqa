import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import { HubApiError } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";
import type { GuidanceKind, PromptName } from "../prompts/prompt-names.ts";
import {
  buildAgentUpdateSystemPrompt,
  buildAgentUpdateUserPrompt,
} from "../prompts/agent-update.ts";
import * as log from "./logger.ts";

export interface UpdateAgentPromptArgs {
  /** Which guidance pair to refresh — `<kind>.agent`. */
  kind: GuidanceKind;
  /** Multi-line summary of the run, fed to the prompt as context. */
  runSummary: string;
  hubContext: HubContext | null;
  model?: string;
  language?: string;
}

/**
 * Refresh the `<kind>.agent` prompt stored on the hub from the latest run.
 *
 * Reads the existing prompt (if any) and a caller-supplied run summary, sends
 * both to Claude, and writes the response back to the hub. Degrades
 * gracefully when auth or the hub connection is missing — logs and returns —
 * so the run exit code is unaffected by this opt-in side step.
 */
export async function updateAgentPrompt(args: UpdateAgentPromptArgs): Promise<void> {
  const { kind, runSummary, hubContext, model, language } = args;

  const auth = driftAuthAvailable();
  if (!auth.ok) {
    log.warn(`--update-agent-prompt skipped (${auth.reason})`);
    return;
  }
  if (!hubContext) {
    log.warn(
      "--update-agent-prompt skipped (hub connection required; pass --hub-url/--hub-token or set CCQA_HUB_URL/CCQA_HUB_TOKEN)",
    );
    return;
  }
  const { hub, project } = hubContext;
  const promptName = `${kind}.agent` as PromptName;

  try {
    const currentAgentMd = await hub.getPrompt(project, promptName);
    const promptInput = {
      kind,
      currentAgentMd,
      runSummary,
      ...(language ? { language } : {}),
    };
    const systemPrompt = buildAgentUpdateSystemPrompt(promptInput);
    const userPrompt = buildAgentUpdateUserPrompt(promptInput);

    log.info(`--update-agent-prompt: refreshing prompt "${promptName}" on the hub (project ${project})`);

    // We don't expose a non-streaming wrapper today; use the streaming one with
    // a no-op event handler — `result` carries the full assistant text.
    // No Bash tool is exposed (allowedTools: [] + disableBuiltinTools: true),
    // so there are no tool_use blocks to silence. Thinking is disabled:
    // thinking-first models can end the turn inside the thinking block with
    // no text, which loses the whole update.
    const { result, isError } = await invokeClaudeStreaming(
      {
        prompt: userPrompt,
        systemPrompt,
        allowedTools: [],
        disableBuiltinTools: true,
        disableThinking: true,
        ...(model ? { model } : {}),
      },
      () => {},
    );

    if (isError || !result || result.trim().length === 0) {
      log.warn(
        `--update-agent-prompt: Claude returned no usable output${isError ? " (SDK error)" : ""}; leaving prompt "${promptName}" unchanged`,
      );
      return;
    }

    // The prompt contract: a run with nothing shortcut-worthy answers with the
    // NO_UPDATE sentinel (clean runs are the common case — not a failure).
    if (result.trim() === "NO_UPDATE") {
      log.info(`--update-agent-prompt: no new learnings from this run; prompt "${promptName}" left unchanged`);
      return;
    }

    const newText = stripCodeFences(result.trim()) + "\n";
    await hub.putPrompt(project, promptName, newText);

    log.info(`--update-agent-prompt: updated prompt "${promptName}" on the hub`);
    log.info("--update-agent-prompt: review it in the hub UI's Prompts tab");
  } catch (err) {
    if (err instanceof HubApiError) {
      log.warn(`--update-agent-prompt skipped (hub request failed: ${err.status} ${err.code}: ${err.message})`);
      return;
    }
    throw err;
  }
}

/**
 * Some models still wrap the answer in a ```markdown fence despite the
 * system prompt asking otherwise. Strip a single outer fence when present so
 * the saved file is clean.
 */
function stripCodeFences(text: string): string {
  const m = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/);
  return m && m[1] !== undefined ? m[1] : text;
}
