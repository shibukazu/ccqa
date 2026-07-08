import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options, HookInput } from "@anthropic-ai/claude-agent-sdk";
import * as log from "../cli/logger.ts";
import { FIND_ACTIONS, FIND_LOCATORS } from "../types.ts";

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
  /**
   * When true, the PreToolUse guards that enforce the trace-time replayability
   * contract on agent-browser commands are skipped: the blocked-subcommand set
   * (`eval` / `js` / ...), the `@ref` selector check, the bare-tag positional
   * `find`, the chained-invocation check, and the error-suppression check are
   * all bypassed. `extractAbActionFromBashCommand` is also skipped because the
   * caller is not building a replayable AB_ACTION stream.
   *
   * Used by `ccqa run` against `mode: live` specs, where Claude needs
   * free-form DOM exploration and judges pass/fail per spec step rather than
   * recording structured actions. Default false preserves trace-mode behaviour
   * byte-for-byte.
   */
  relaxAbConstraints?: boolean;
}

export function resolveModel(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const envModel = process.env["CCQA_MODEL"];
  return envModel && envModel.length > 0 ? envModel : undefined;
}

/**
 * Standard Claude Code environment variables that select the API endpoint and
 * credentials. ccqa forwards whichever of these are set to the underlying
 * Claude Code process; it does not read or interpret their values.
 *
 * - `ANTHROPIC_BASE_URL`      — the API endpoint to send requests to.
 * - `ANTHROPIC_AUTH_TOKEN`    — sent as `Authorization: Bearer <token>`.
 * - `ANTHROPIC_API_KEY`       — API key, when used instead of a token.
 * - `ANTHROPIC_CUSTOM_HEADERS` — extra request headers.
 */
const ENDPOINT_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * Collects the endpoint/auth variables set in the current process environment
 * so they can be forwarded, verbatim, to every Claude Code invocation. Returns
 * only the keys that are actually set (non-empty), so unset variables never
 * override the SDK's own defaults.
 */
export function resolveEndpointEnv(): Record<string, string> {
  const endpointEnv: Record<string, string> = {};
  for (const key of ENDPOINT_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length > 0) endpointEnv[key] = value;
  }
  return endpointEnv;
}

/**
 * Per-invocation cost + usage record extracted from the SDK's `result` message.
 * All fields are `null` when the SDK didn't surface a `result` message (e.g.
 * the mock replay shim used in unit tests).
 *
 * `totalCostUsd` is the SDK's own billing estimate; downstream code uses it
 * to surface "this run cost $X" in reports and exports.
 */
export interface ClaudeInvocationCost {
  totalCostUsd: number | null;
  /** SDK-reported wall time spent in the run, ms. */
  durationMs: number | null;
  /** Time spent talking to the model API (excludes tool execution), ms. */
  durationApiMs: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  /**
   * Model id(s) the SDK actually used for this invocation. The SDK's
   * `modelUsage` is a map keyed by model id; we surface the keys so reports
   * can show "this run used claude-opus-4-7" vs "this run used
   * claude-sonnet-4-6". Empty array when the SDK didn't surface the field.
   */
  models: string[];
}

export interface InvokeClaudeStreamingResult {
  result: string;
  isError: boolean;
  cost: ClaudeInvocationCost;
}

export async function invokeClaudeStreaming(
  options: ClaudeInvokeOptions,
  onEvent: (msg: SDKMessage) => void,
): Promise<InvokeClaudeStreamingResult> {
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
    relaxAbConstraints = false,
  } = options;

  const resolvedModel = resolveModel(model);

  // Forward the endpoint/auth variables (ANTHROPIC_BASE_URL, ...) to the Claude
  // Code process so it can be pointed at a custom endpoint. When any is set (or
  // the caller passes its own env), we materialise `env` from the full process
  // environment and layer the caller's overrides on top, so those variables are
  // always carried through. When none is set and the caller passes no env, we
  // leave `env` unset and let the SDK use its own default.
  const hasEndpointEnv = Object.keys(resolveEndpointEnv()).length > 0;
  const mergedEnv =
    env || hasEndpointEnv
      ? ({ ...process.env, ...env } as Record<string, string | undefined>)
      : undefined;

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
    ...(mergedEnv ? { env: mergedEnv } : {}),
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

                    if (!relaxAbConstraints) {
                      // Block eval/js/find/etc — they bypass structured action recording
                      if (isBlockedAbSubcommand(cmd)) {
                        return {
                          decision: "block",
                          reason: "This agent-browser subcommand is not allowed because it cannot be recorded as a structured test action. Use only the standard commands: click, check, fill, select, hover, press, wait, find (with role/text/label/placeholder/alt/title/testid/first/last/nth). Take a fresh snapshot to find the correct selector.",
                        };
                      }

                      // Block @ref selectors — they are session-specific and not replayable
                      if (hasRefSelector(cmd)) {
                        return {
                          decision: "block",
                          reason: "@ref selectors (like @e14) are session-specific and change every run. They cannot be used in generated tests. Use one of the allowed selector formats instead: [aria-label='...'], text=..., [placeholder='...'], or [type='password']. Take a fresh snapshot and find the element's aria-label or visible text.",
                        };
                      }

                      const bareTag = findPositionalBareTag(cmd);
                      if (bareTag !== null) {
                        return {
                          decision: "block",
                          reason: `\`find ${bareTag.locator}\` with a bare tag selector (\`${bareTag.selector}\`) is rejected: it matches every <${bareTag.selector}> on the page and is non-deterministic on replay. Pass a specific attribute selector instead, e.g. \`find ${bareTag.locator} "[aria-label='...']" ${bareTag.action}\` or \`find ${bareTag.locator} "[data-qa='...']" ${bareTag.action}\`. Take a fresh snapshot to find the right attribute.`,
                        };
                      }

                      // Block compound `agent-browser` invocations — a single Bash
                      // call may only run one agent-browser command. Without this
                      // the PreToolUse hook records a single AB_ACTION while the
                      // shell runs several, and a failed attempt slipped inside
                      // the chain can't be rolled back via PostToolUse.
                      if (hasMultipleAbInvocations(cmd)) {
                        return {
                          decision: "block",
                          reason: "Run each `agent-browser` call as its own Bash command. Chaining multiple invocations with &&, ;, |, or || prevents ccqa from recording them as discrete steps and lets failed attempts leak into the trace. Issue one Bash tool call per agent-browser command.",
                        };
                      }

                      // Block error-suppression decorators on agent-browser
                      // commands — they hide non-zero exits from PostToolUse and
                      // let failed attempts get baked into actions.json.
                      if (hasErrorSuppression(cmd)) {
                        return {
                          decision: "block",
                          reason: "Do not suppress errors on `agent-browser` commands. Remove `|| true`, `|| :`, `2>/dev/null`, `; true`, and similar redirects so ccqa can detect failures and roll back unsuccessful attempts. Run the command standalone and let it surface its exit code.",
                        };
                      }
                    }

                    const ab = relaxAbConstraints ? null : extractAbActionFromBashCommand(cmd);
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
  let cost: ClaudeInvocationCost = {
    totalCostUsd: null,
    durationMs: null,
    durationApiMs: null,
    numTurns: null,
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    models: [],
  };

  const q = await buildMessageStream(prompt, sdkOptions);

  // The SDK throws (rather than emitting a `result` message) when the Claude
  // Code subprocess exits with a non-success terminal state (max-turn budget
  // exhausted, internal SDK error, etc). Treat that as an analyzable failure
  // so callers (failure analysis, drift audit, live executor) can degrade
  // gracefully instead of crashing the whole run.
  try {
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
        cost = extractInvocationCost(msg);
      }
    }
  } catch (err) {
    isError = true;
    if (!result) {
      result = err instanceof Error ? err.message : String(err);
    }
  }

  return { result, isError, cost };
}

/**
 * Pull the cost / usage / turn / duration fields off the SDK `result` message.
 * The SDK's success and error result shapes share these fields, so we read
 * them defensively as `unknown` and coerce — newer SDK versions may rename a
 * field without breaking our extraction.
 */
export function extractInvocationCost(msg: SDKMessage): ClaudeInvocationCost {
  const m = msg as unknown as Record<string, unknown>;
  const usage = m["usage"] as Record<string, unknown> | undefined;
  const modelUsage = m["modelUsage"] as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    totalCostUsd: num(m["total_cost_usd"]),
    durationMs: num(m["duration_ms"]),
    durationApiMs: num(m["duration_api_ms"]),
    numTurns: num(m["num_turns"]),
    inputTokens: num(usage?.["input_tokens"]),
    cacheCreationInputTokens: num(usage?.["cache_creation_input_tokens"]),
    cacheReadInputTokens: num(usage?.["cache_read_input_tokens"]),
    outputTokens: num(usage?.["output_tokens"]),
    models: modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage) : [],
  };
}

const BLOCKED_AB_SUBCOMMANDS = new Set(["eval", "js", "label", "textbox"]);

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

/**
 * Detect `agent-browser ... find first|last|nth <bare-tag> <action>`. A bare
 * tag inside a *positional* finder matches every element of that tag on the
 * page, so "the last button" picks a different element whenever the page
 * shape shifts — recorded tests built on top are flaky by construction. The
 * check is narrow on purpose: `find role button --name X` is fine because
 * role + accessible name stays stable.
 */
export function findPositionalBareTag(
  cmd: string,
): { locator: "first" | "last" | "nth"; selector: string; action: string } | null {
  if (extractAbSubcommand(cmd) !== "find") return null;
  const abIdx = cmd.indexOf("agent-browser");
  const rest = cmd.slice(abIdx + "agent-browser".length).trim();
  const parts = shellTokenize(rest);
  let i = 0;
  while (i < parts.length && parts[i]!.startsWith("-")) { i += 2; }
  // parts[i] === "find"; locator follows.
  const locator = parts[i + 1];
  if (locator !== "first" && locator !== "last" && locator !== "nth") return null;
  const innerIdx = locator === "nth" ? i + 3 : i + 2;
  const inner = parts[innerIdx];
  const action = parts[innerIdx + 1] ?? "";
  if (!inner) return null;
  // A "bare tag" looks like one HTML identifier: letters only, no `[`, `.`,
  // `#`, space, or attribute. Allow common HTML tags conservatively.
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(inner)) return null;
  return { locator, selector: inner, action };
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
 * Returns true when `cmd` contains more than one `agent-browser` invocation
 * chained together via shell operators (`&&`, `||`, `;`, `|`). The
 * PreToolUse hook only records ONE AB_ACTION per Bash call, so chained
 * invocations would silently drop every intermediate failure — turning
 * "I tried four selectors before one worked" into a clean-looking trace
 * with five orphaned actions that later fail at replay.
 *
 * The check tokenizes the command and counts `agent-browser` occurrences
 * that appear at the start of a shell command (i.e. immediately after a
 * statement separator or at index 0). String literals are honoured so
 * `agent-browser fill 'agent-browser'` doesn't false-fire.
 */
export function hasMultipleAbInvocations(cmd: string): boolean {
  // Walk the command and find statement boundaries that aren't inside
  // string quotes. A statement starts at position 0 or right after one of
  // these unquoted tokens.
  const boundaries: number[] = [0];
  let quote: '"' | "'" | "`" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      // Step past consecutive separator chars (`&&`, `||`, `;;` etc).
      while (i + 1 < cmd.length && (cmd[i + 1] === "|" || cmd[i + 1] === "&" || cmd[i + 1] === ";")) i++;
      boundaries.push(i + 1);
    }
  }
  let count = 0;
  for (const start of boundaries) {
    // Skip leading whitespace at each boundary, then check if the next
    // word is `agent-browser`. Word match avoids picking up substrings.
    let j = start;
    while (j < cmd.length && (cmd[j] === " " || cmd[j] === "\t" || cmd[j] === "\n")) j++;
    if (cmd.slice(j, j + "agent-browser".length) !== "agent-browser") continue;
    const after = cmd[j + "agent-browser".length];
    // Followed by whitespace, end of string, or flag — anything that
    // shows this is the command head, not e.g. `agent-browser-cli`.
    if (after !== undefined && /[A-Za-z0-9_\-]/.test(after)) continue;
    count++;
    if (count > 1) return true;
  }
  return false;
}

/**
 * Returns true when an `agent-browser` command in `cmd` has its exit
 * status hidden by a shell decorator that would prevent ccqa from rolling
 * back a failed attempt:
 *
 *   - trailing `|| true` / `|| :` / `; true` (force exit 0)
 *   - `2>/dev/null` and friends (drop stderr, sometimes paired with `|| true`)
 *
 * The agent-browser command itself returns exit 1 on selector miss, so
 * once one of these is present the PostToolUse hook sees `is_error=false`
 * and the bad attempt sneaks into actions.json.
 */
export function hasErrorSuppression(cmd: string): boolean {
  if (cmd.indexOf("agent-browser") === -1) return false;
  // `|| true` / `|| :` — common forms used to swallow non-zero exit.
  if (/\|\|\s*(true|:|\s*$|#)/.test(cmd)) return true;
  // `; true` / `; :` at end of pipeline.
  if (/;\s*(true|:)\b/.test(cmd)) return true;
  // stderr drop. We allow `2>&1` only when the intent is to capture for
  // logging (e.g. `2>&1 | head`) — that doesn't change exit status. The
  // ones we ban actually discard:
  if (/2\s*>\s*\/dev\/null/.test(cmd)) return true;
  if (/&\s*>\s*\/dev\/null/.test(cmd)) return true;
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
    case "upload": {
      // `upload <selector> <file1> [<file2> ...]` — selector first, then one or
      // more file paths. Encoded as `AB_ACTION|upload|<sel>|<file1>|<file2>|...`
      // (variable trailing positionals; trace.ts splits the same way).
      const sel = args[0] ?? "";
      const files = args.slice(1);
      if (!sel || files.length === 0) return null;
      return `AB_ACTION|upload|${sel}|${files.join("|")}`;
    }
    case "snapshot":
      // snapshot AB_ACTION is emitted by LLM with its own observation
      return null;
    case "find":
      return extractFindAbAction(args);
    default:
      return null;
  }
}

const FIND_ACTION_SET: ReadonlySet<string> = new Set(FIND_ACTIONS);
const FIND_LOCATOR_SET: ReadonlySet<string> = new Set(FIND_LOCATORS);

/**
 * Parse the positional tokens of `agent-browser find <locator> <value> [...]
 * <action> [fillValue]` and produce a canonical
 *   `AB_ACTION|find_<action>|<locator>|<value>|<extra>|<exact>|...|<label>`
 * line. The wire format keeps a fixed positional layout across locators so
 * downstream `parseAbAction` in `cli/trace.ts` can split on `|` alone:
 *
 *   <extra> is `--name` value for role, integer index for nth, "" otherwise.
 *   <exact> is the literal "exact" if --exact was passed, "" otherwise.
 *
 * Returns null for malformed invocations — the caller treats null as "not a
 * structured action" and the Bash command still runs unobserved.
 */
export function extractFindAbAction(args: string[]): string | null {
  const locator = args[0];
  if (!locator || !FIND_LOCATOR_SET.has(locator)) return null;

  let i = 1;
  let value = args[i] ?? "";
  i++;

  let extra = "";
  if (locator === "nth") {
    // `find nth <index> <selector>` — index lives in <extra>, selector in <value>.
    extra = value;
    value = args[i] ?? "";
    i++;
  }

  let action = "";
  let name = "";
  let exact = "";
  let fillValue = "";

  for (; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--name") {
      // `--name` is only meaningful for `find role`. Capture it unconditionally
      // here so we always consume its value (otherwise the next-token loop iter
      // would treat the value as the action token), but only carry it forward
      // when the locator actually accepts it.
      name = args[i + 1] ?? "";
      i++;
    } else if (tok === "--exact") {
      exact = "exact";
    } else if (FIND_ACTION_SET.has(tok)) {
      action = tok;
    } else if (action) {
      // After the action token, the remaining positional is fill text.
      fillValue = tok;
    }
  }

  if (!action) return null;
  if (locator === "role") extra = name;

  const command = `find_${action}`;
  if (action === "fill" || action === "type") {
    return `AB_ACTION|${command}|${locator}|${value}|${extra}|${exact}|${fillValue}|`;
  }
  return `AB_ACTION|${command}|${locator}|${value}|${extra}|${exact}|`;
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

