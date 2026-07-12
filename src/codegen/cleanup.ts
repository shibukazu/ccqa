import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { buildCleanupPrompt } from "../prompts/codegen.ts";
import type { RecordedAction } from "../types.ts";

/**
 * Best-effort cleanup of a recorded action list. Hands the actions to
 * Claude with the cleanup prompt and parses the returned JSON array; on
 * any failure (Claude error, malformed JSON, empty array) falls back to
 * the original input so the caller can always proceed.
 *
 * Note: the prompt deliberately does not surface the `stepId` field.
 * Callers that need to preserve stepIds across cleanup (only `ccqa generate`
 * today) must re-attach them after this returns.
 */
export async function cleanupActions(actions: RecordedAction[], model?: string): Promise<RecordedAction[]> {
  try {
    const prompt = buildCleanupPrompt(actions);
    const { result, isError } = await invokeClaudeStreaming(
      { prompt, disableBuiltinTools: true, maxTurns: 1, model },
      () => {},
    );
    if (isError || !result) return actions;
    const json = result.trim().replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/, "$1").trim();
    const parsed = JSON.parse(json) as RecordedAction[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Fall through
  }
  return actions;
}
