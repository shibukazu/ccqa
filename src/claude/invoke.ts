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
  /**
   * Claude model alias ('sonnet' | 'opus' | 'haiku') or full model ID
   * (e.g. 'claude-opus-4-7'). Falls back to `CCQA_MODEL`, then to the
   * Claude Code CLI default when unset.
   */
  model?: string;
  /**
   * Working directory the SDK exposes to its tools (Read/Grep/Glob/Bash).
   * Falls back to `process.cwd()` when unset. Used by `ccqa drift --cwd` to
   * point Claude at a specific package inside a monorepo.
   */
  cwd?: string;
  /** Called when an agent-browser command is intercepted; receives the AB_ACTION line. */
  onAbAction?: (abAction: string) => void;
  /** Called when an agent-browser command fails (exit non-zero); allows rolling back the last AB_ACTION. */
  onAbActionFailed?: () => void;
  /** When true, suppresses the default per-Bash-tool-call log line. Callers that
   * want a summary view (e.g. `ccqa draft`) can opt out and tally tool usage
   * themselves via `onEvent`. */
  silenceBashLog?: boolean;
}

export function resolveModel(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const envModel = process.env["CCQA_MODEL"];
  return envModel && envModel.length > 0 ? envModel : undefined;
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
    model,
    cwd,
    onAbAction,
    onAbActionFailed,
    silenceBashLog = false,
  } = options;

  const resolvedModel = resolveModel(model);

  // Track the last agent-browser tool_use_id so the post-tool hooks can roll
  // it back at most once. `claimAbToolUse` atomically tests-and-clears the id
  // so PostToolUse and PostToolUseFailure can't both fire `onAbActionFailed`
  // for the same tool call (SDK order between the two channels is unspecified).
  let lastAbToolUseId: string | null = null;
  const claimAbToolUse = (toolUseId: string): boolean => {
    if (toolUseId !== lastAbToolUseId) return false;
    lastAbToolUseId = null;
    return true;
  };

  const sdkOptions: Options = {
    systemPrompt,
    maxTurns,
    allowedTools: allowedTools ?? ["Bash(*)"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(cwd ? { cwd } : {}),
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
            // SDK splits hook events into two channels for tool results:
            //   - PostToolUse:        tool produced a response (success OR Bash exit-code-non-zero)
            //   - PostToolUseFailure: tool itself never produced a response (throw, permission denied, ...)
            //
            // For agent-browser invocations the failure mode is almost always
            // `agent-browser exit 1` after a selector miss or timeout — that
            // case surfaces on PostToolUse with `tool_response.is_error: true`
            // (and/or non-zero `exitCode`), NOT on PostToolUseFailure. So the
            // rollback logic has to live on both channels: PostToolUse handles
            // the common exit-code path, PostToolUseFailure stays as a fallback
            // for SDK-level breakage (process killed, etc.).
            PostToolUse: [
              {
                hooks: [
                  async (input: HookInput) => {
                    if (input.hook_event_name !== "PostToolUse") return {};
                    if (input.tool_name !== "Bash") return {};
                    if (!isBashToolResponseError(input.tool_response)) return {};
                    if (claimAbToolUse(input.tool_use_id) && onAbActionFailed) {
                      onAbActionFailed();
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
                    if (claimAbToolUse(input.tool_use_id) && onAbActionFailed) {
                      onAbActionFailed();
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

    if (msg.type === "assistant" && !silenceBashLog) {
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

/**
 * Detects "the Bash tool returned an error" from a SDK PostToolUse hook's
 * `tool_response`. The SDK can shape this two ways depending on how Claude
 * Code reports Bash failures:
 *
 *   - `{ is_error: true, ... }`              — the canonical Bash failure shape
 *   - `{ output, exitCode, killed?, ... }`   — the BashOutput shape; treat
 *                                              non-zero exit / kill as error
 *
 * We accept either. Anything else (including missing fields) is treated as a
 * successful response so we never roll back over an unrelated tool call.
 */
export function isBashToolResponseError(tool_response: unknown): boolean {
  if (tool_response === null || typeof tool_response !== "object") return false;
  const r = tool_response as Record<string, unknown>;
  if (r["is_error"] === true) return true;
  if (typeof r["exitCode"] === "number" && r["exitCode"] !== 0) return true;
  if (r["killed"] === true) return true;
  return false;
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

