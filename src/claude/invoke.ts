import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options, HookInput } from "@anthropic-ai/claude-agent-sdk";
import * as log from "../cli/logger.ts";

export interface ClaudeInvokeOptions {
  prompt: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disableBuiltinTools?: boolean;
  mcpConfigPath?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  /** Called when an agent-browser command is intercepted; receives the AB_ACTION line. */
  onAbAction?: (abAction: string) => void;
  /** Called when an agent-browser command fails (exit non-zero); allows rolling back the last AB_ACTION. */
  onAbActionFailed?: () => void;
}

export async function invokeClaudeStreaming(
  options: ClaudeInvokeOptions,
  onEvent: (msg: SDKMessage) => void,
): Promise<{ result: string; isError: boolean }> {
  const {
    prompt,
    systemPrompt,
    allowedTools,
    disableBuiltinTools = false,
    maxTurns,
    env,
    onAbAction,
    onAbActionFailed,
  } = options;

  // Track the last agent-browser tool_use_id so PostToolUseFailure can roll back
  let lastAbToolUseId: string | null = null;

  const sdkOptions: Options = {
    systemPrompt,
    maxTurns,
    allowedTools: allowedTools ?? ["Bash(*)"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(env ? { env: { ...process.env, ...env } as Record<string, string | undefined> } : {}),
    ...(disableBuiltinTools ? { tools: [] } : {}),
    hooks:
      onAbAction || onAbActionFailed
        ? {
            PreToolUse: [
              {
                hooks: [
                  async (input: HookInput) => {
                    if (input.hook_event_name !== "PreToolUse") return {};
                    if (input.tool_name !== "Bash") return {};
                    const cmd = (input.tool_input as Record<string, unknown>)?.["command"];
                    if (typeof cmd !== "string") return {};

                    // Block eval/js/find/etc — they bypass structured action recording
                    if (isBlockedAbSubcommand(cmd)) {
                      return {
                        decision: "block",
                        reason: "This agent-browser subcommand is not allowed because it cannot be recorded as a structured test action. Use only the standard commands: click, check, fill, select, hover, press, wait. Take a fresh snapshot to find the correct selector.",
                      };
                    }

                    // Block @ref selectors — they are session-specific and not replayable
                    if (hasRefSelector(cmd)) {
                      return {
                        decision: "block",
                        reason: "@ref selectors (like @e14) are session-specific and change every run. They cannot be used in generated tests. Use one of the allowed selector formats instead: [aria-label='...'], text=..., [placeholder='...'], or [type='password']. Take a fresh snapshot and find the element's aria-label or visible text.",
                      };
                    }

                    const ab = extractAbActionFromBashCommand(cmd);
                    if (ab && onAbAction) {
                      lastAbToolUseId = input.tool_use_id;
                      onAbAction(ab);
                    } else {
                      lastAbToolUseId = null;
                    }
                    return {};
                  },
                ],
              },
            ],
            PostToolUseFailure: [
              {
                hooks: [
                  async (input: HookInput) => {
                    if (input.hook_event_name !== "PostToolUseFailure") return {};
                    if (input.tool_name !== "Bash") return {};
                    // If the failed Bash command was the one that emitted an AB_ACTION, roll it back
                    if (input.tool_use_id === lastAbToolUseId && onAbActionFailed) {
                      onAbActionFailed();
                      lastAbToolUseId = null;
                    }
                    return {};
                  },
                ],
              },
            ],
          }
        : undefined,
  };

  let result = "";
  let isError = false;

  const q = await buildMessageStream(prompt, sdkOptions);

  for await (const msg of q) {
    onEvent(msg);

    if (msg.type === "assistant") {
      for (const block of msg.message.content ?? []) {
        if (block.type === "tool_use" && block.name === "Bash") {
          const cmd = (block.input as Record<string, unknown>)?.["command"];
          if (typeof cmd === "string") log.bash(cmd);
        }
      }
    }

    if (msg.type === "result") {
      result = msg.subtype === "success" ? msg.result : "";
      isError = msg.is_error ?? false;
    }
  }

  return { result, isError };
}

const BLOCKED_AB_SUBCOMMANDS = new Set(["eval", "js", "find", "label", "textbox"]);

/**
 * Shell-aware tokenizer: splits a command string into tokens respecting single/double quotes.
 * e.g. `click "[role='dialog'] button:last-child"` → ["click", "[role='dialog'] button:last-child"]
 */
export function shellTokenize(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) { quote = null; }
      else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur) { tokens.push(cur); cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Extracts the subcommand from an `agent-browser [flags] <subcommand> [args...]` command string. */
export function extractAbSubcommand(cmd: string): string | null {
  const abIdx = cmd.indexOf("agent-browser");
  if (abIdx === -1) return null;
  const rest = cmd.slice(abIdx + "agent-browser".length).trim();
  const parts = shellTokenize(rest);
  let i = 0;
  while (i < parts.length && parts[i]!.startsWith("-")) { i += 2; }
  return parts[i] ?? null;
}

/** Returns true if the agent-browser subcommand is blocked (eval/js/find/etc). */
export function isBlockedAbSubcommand(cmd: string): boolean {
  const sub = extractAbSubcommand(cmd);
  return sub !== null && BLOCKED_AB_SUBCOMMANDS.has(sub);
}

/** Returns true if any argument to an agent-browser command uses a @ref selector (e.g. @e14). */
export function hasRefSelector(cmd: string): boolean {
  const abIdx = cmd.indexOf("agent-browser");
  if (abIdx === -1) return false;
  const rest = cmd.slice(abIdx + "agent-browser".length).trim();
  const parts = shellTokenize(rest);
  // Skip flags and subcommand, check remaining args
  let i = 0;
  while (i < parts.length && parts[i]!.startsWith("-")) { i += 2; }
  i++; // skip subcommand
  for (; i < parts.length; i++) {
    if (/^@/.test(parts[i]!)) return true;
  }
  return false;
}

/**
 * Parse an `agent-browser --session <name> <cmd> [args...]` bash command
 * and return the corresponding AB_ACTION line, or null if not an agent-browser call.
 */
export function extractAbActionFromBashCommand(cmd: string): string | null {
  const subCmd = extractAbSubcommand(cmd);
  if (!subCmd) return null;

  // Extract everything after "agent-browser" to get args (shell-aware tokenization)
  const abIdx = cmd.indexOf("agent-browser");
  const rest = cmd.slice(abIdx + "agent-browser".length).trim();
  // Filter out shell redirects/pipes (2>&1, >&1, |, >file) that are not agent-browser args
  const parts = shellTokenize(rest).filter(t => !/^(2?>|[|&>])/.test(t));
  let i = 0;
  while (i < parts.length && parts[i]!.startsWith("-")) { i += 2; }
  const args = parts.slice(i + 1);

  switch (subCmd) {
    case "cookies":
      if (args[0] === "clear") return "AB_ACTION|cookies_clear";
      return null;
    case "open":
      return `AB_ACTION|open|${args[0] ?? ""}`;
    case "press":
      return `AB_ACTION|press|${args[0] ?? ""}`;
    case "scroll":
      return `AB_ACTION|scroll|${args.join("|")}`;
    case "click":
    case "dblclick":
    case "check":
    case "uncheck":
    case "hover":
    case "wait":
      return `AB_ACTION|${subCmd}|${args[0] ?? ""}|${args[1] ?? ""}`;
    case "fill":
    case "type":
    case "select":
      return `AB_ACTION|${subCmd}|${args[0] ?? ""}|${args[1] ?? ""}|${args[2] ?? ""}`;
    case "drag":
      return `AB_ACTION|drag|${args[0] ?? ""}|${args[1] ?? ""}|${args[2] ?? ""}`;
    case "snapshot":
      // snapshot AB_ACTION is emitted by LLM with its own observation
      return null;
    default:
      return null;
  }
}

// Chooses between the real Claude Agent SDK and a JSONL replay. The mock
// path is guarded behind an env var so production builds never take it.
async function buildMessageStream(
  prompt: string,
  options: Options,
): Promise<AsyncIterable<SDKMessage>> {
  const mockFile = process.env["CCQA_CLAUDE_MOCK_FILE"];
  if (mockFile) return replayMockMessages(mockFile);
  return query({ prompt, options });
}

async function* replayMockMessages(path: string): AsyncIterable<SDKMessage> {
  const raw = await readFile(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as SDKMessage;
  }
}

