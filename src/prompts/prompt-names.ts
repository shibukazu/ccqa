import { join } from "node:path";

/**
 * The fixed set of prompt assets the hub stores per project/profile, and which
 * each is fetched at run time by the CLI. Kept as a tiny, dependency-free
 * module so both the hub side (store/handlers) and the client/CLI can share
 * the names without a circular import.
 *
 * Two kinds share one namespace:
 *  - "guidance": the record/live prompt bundle — `.user.md` (human-maintained)
 *    and `.agent.md` (auto-rewritten by `ccqa run --update-agent-prompt`).
 *  - "custom-prompt": `analysis-custom-prompt` — Claude-written calibration guidance
 *    learned from graded triage cases, injected into the failure-analysis
 *    prompt at run time.
 *
 * Hub names are extensionless (`record.agent`), local files keep their real
 * extensions; `PROMPT_LOCAL_PATHS` is the single mapping every caller (push,
 * pull, learn, UI) goes through so the two never drift.
 */
export const PROMPT_NAMES = [
  "record.user",
  "record.agent",
  "live.user",
  "live.agent",
  "analysis-custom-prompt",
] as const;

export type PromptName = (typeof PROMPT_NAMES)[number];

/** True for a value that is one of the reserved prompt names. */
export function isPromptName(value: string): value is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(value);
}

/** Which of the two kinds a name belongs to (drives UI grouping and meta). */
export function promptKind(name: PromptName): "guidance" | "custom-prompt" {
  return name === "analysis-custom-prompt" ? "custom-prompt" : "guidance";
}

/** Local path (relative to a `.ccqa` tree) each hub prompt restores to. */
export const PROMPT_LOCAL_PATHS: Record<PromptName, string> = {
  "record.user": ".ccqa/prompts/record.user.md",
  "record.agent": ".ccqa/prompts/record.agent.md",
  "live.user": ".ccqa/prompts/live.user.md",
  "live.agent": ".ccqa/prompts/live.agent.md",
  "analysis-custom-prompt": ".ccqa/prompts/analysis-custom-prompt.json",
};

/** Absolute local path a hub prompt pulls down to, under `cwd` (default `process.cwd()`). */
export function resolvePromptLocalPath(name: PromptName, cwd?: string): string {
  return join(cwd ?? process.cwd(), PROMPT_LOCAL_PATHS[name]);
}
