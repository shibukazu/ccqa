import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { driftAuthAvailable } from "../drift/auth.ts";
import {
  buildAgentUpdateSystemPrompt,
  buildAgentUpdateUserPrompt,
} from "../prompts/agent-update.ts";
import * as log from "./logger.ts";

export interface UpdateAgentPromptArgs {
  mode: "live" | "record";
  /** Multi-line summary of the run, fed to the prompt as context. */
  runSummary: string;
  cwd: string;
  model?: string;
  language?: string;
}

/**
 * Refresh `.ccqa/prompts/<mode>.agent.md` from the latest run.
 *
 * Reads the existing file (if any) and a caller-supplied run summary, sends
 * both to Claude, and writes the response back over the agent prompt file.
 * Degrades gracefully when auth is missing — logs and returns — so the run
 * exit code is unaffected by this opt-in side step.
 */
export async function updateAgentPrompt(args: UpdateAgentPromptArgs): Promise<void> {
  const { mode, runSummary, cwd, model, language } = args;
  const agentMdPath = join(cwd, ".ccqa", "prompts", `${mode}.agent.md`);
  const relPath = relative(cwd, agentMdPath);

  const auth = driftAuthAvailable();
  if (!auth.ok) {
    log.warn(`--update-agent-prompt skipped (${auth.reason})`);
    return;
  }

  const currentAgentMd = await readFile(agentMdPath, "utf-8").catch(() => null);
  const promptInput = {
    mode,
    currentAgentMd,
    runSummary,
    ...(language ? { language } : {}),
  };
  const systemPrompt = buildAgentUpdateSystemPrompt(promptInput);
  const userPrompt = buildAgentUpdateUserPrompt(promptInput);

  log.info(`--update-agent-prompt: refreshing ${relPath}`);

  // We don't expose a non-streaming wrapper today; use the streaming one with
  // a no-op event handler — `result` carries the full assistant text.
  // No Bash tool is exposed (allowedTools: [] + disableBuiltinTools: true),
  // so there are no tool_use blocks to silence.
  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: userPrompt,
      systemPrompt,
      allowedTools: [],
      disableBuiltinTools: true,
      ...(model ? { model } : {}),
    },
    () => {},
  );

  if (isError || !result || result.trim().length === 0) {
    log.warn(
      `--update-agent-prompt: Claude returned no usable output${isError ? " (SDK error)" : ""}; leaving ${relPath} unchanged`,
    );
    return;
  }

  const newText = stripCodeFences(result.trim()) + "\n";
  await mkdir(dirname(agentMdPath), { recursive: true });
  await writeFile(agentMdPath, newText, "utf-8");

  log.info(`--update-agent-prompt: wrote ${relPath} (${newText.length} bytes)`);
  log.info(`--update-agent-prompt: review the diff with: git diff -- "${relPath}"`);
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
