import { createHash } from "node:crypto";
import { z } from "zod";
import type { HubContext } from "../cli/hub-conn.ts";
import { FailureLabelSchema } from "../report/schema.ts";

/**
 * The two hub prompts `buildFailureAnalysisPrompt` can inject into the
 * (otherwise fixed) failure-analysis prompt:
 *
 *  - `triage.user` — human-maintained, project-specific classification
 *    guidance (plain Markdown), the triage counterpart of `record.user` /
 *    `live.user`.
 *  - `analysis-custom-prompt` — a short prose calibration note, learned by
 *    Claude from human-graded past failures (a hub triage-learning job).
 *    Effectively triage's `.agent` overlay; a future migration may fold it
 *    into the `<kind>.user`/`<kind>.agent` naming as `triage.agent`, but for
 *    now it keeps its own name and JSON storage shape.
 *
 * Project-specific content (the guidance text, informed by real feature/spec
 * names and failure signals) lives here and on the hub — never hard-coded
 * into ccqa itself.
 */

export const AnalysisCustomPromptSchema = z.object({
  schemaVersion: z.literal(1),
  /** ANALYSIS_PROMPT_VERSION this custom prompt was built against. */
  basePromptVersion: z.string(),
  /** Custom prompt's own version — the stratification key for accuracy tracking. */
  customPromptVersion: z.string(),
  generatedAt: z.string(),
  /** Claude-written calibration note distilled from graded triage cases. */
  guidance: z.string(),
});
export type AnalysisCustomPrompt = z.infer<typeof AnalysisCustomPromptSchema>;

/**
 * Render the custom prompt as a prompt section, or "" when there's nothing to add.
 * Returning "" for the empty/absent case is what keeps the base prompt
 * byte-for-byte identical when no custom prompt is supplied (backward compatibility).
 */
export function buildCustomPromptBlock(customPrompt: AnalysisCustomPrompt | null | undefined): string {
  if (!customPrompt || !customPrompt.guidance.trim()) return "";
  return `## Calibration guidance from human-graded past failures

This is a short note Claude learned from real, human-verified classifications
on this project. Treat it as calibration for this project's conventions — not
as a rule to copy verbatim; the current failure may differ.

${customPrompt.guidance}
`;
}

/**
 * A graded triage case, flattened across runs, ready to feed a learning job.
 * `matches` is whether the model's prediction equalled the human call.
 */
export interface GradedCase {
  predicted: string;
  actualCause: z.infer<typeof FailureLabelSchema>;
  evidenceSignal: string;
  matches: boolean;
}

/**
 * Fetch the analysis custom prompt from the hub (best-effort). Returns null
 * when there's no hub context, the hub has no prompt stored, or the stored
 * value fails to parse — a broken/missing custom prompt must never stop a run.
 */
export async function fetchCustomPrompt(
  ctx: HubContext | null,
): Promise<AnalysisCustomPrompt | null> {
  if (!ctx) return null;
  try {
    const raw = await ctx.hub.getPrompt(ctx.project, "analysis-custom-prompt");
    if (raw === null) return null;
    const parsed = AnalysisCustomPromptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Render the human-maintained `triage.user` guidance as a prompt section, or
 * "" when there's nothing to add — same backward-compatibility contract as
 * `buildCustomPromptBlock`. It renders BEFORE the learned calibration block
 * (human standing guidance first, learned calibration second), mirroring the
 * user → agent order of the record/live prompt bundles.
 */
export function buildTriageUserPromptBlock(text: string | null | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return "";
  return `## Project triage guidance (human-maintained)

Standing, project-specific classification guidance written by this project's
maintainers (the \`triage.user\` hub prompt). Apply it where it speaks to the
failure at hand; the general rules above still hold where it is silent.

${trimmed}
`;
}

/**
 * Fetch the `triage.user` prompt (plain Markdown) from the hub. Same
 * best-effort contract as `fetchCustomPrompt`: no hub context, no stored
 * prompt, an empty body, or a fetch failure all resolve to null.
 */
export async function fetchTriageUserPrompt(ctx: HubContext | null): Promise<string | null> {
  if (!ctx) return null;
  try {
    const raw = await ctx.hub.getPrompt(ctx.project, "triage.user");
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Short, stable content hash for a `triage.user` prompt. The Markdown body
 * carries no version of its own (unlike `customPromptVersion`), so reports
 * record this hash as the stratification key for comparing triage accuracy
 * across guidance edits.
 */
export function hashTriageUserPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
