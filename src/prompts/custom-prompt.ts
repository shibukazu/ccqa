import { createHash } from "node:crypto";
import { z } from "zod";
import type { HubContext } from "../cli/hub-conn.ts";
import type { ActualCause } from "../report/schema.ts";
import * as log from "../cli/logger.ts";

/** The two learned (Claude-written) calibration prompts; see prompt-names.ts. */
export type LearnedPromptName = "triage.agent" | "audit.agent";
/** The two human-maintained standing-guidance prompts. */
export type UserPromptName = "triage.user" | "audit.user";

/**
 * The hub prompts `buildFailureAnalysisPrompt` (the run) and
 * `buildDriftSystemPrompt` (the audit) can each inject into their otherwise
 * fixed system prompt:
 *
 *  - `triage.user` / `audit.user` — human-maintained, project-specific
 *    guidance (plain Markdown), the triage/audit counterpart of `record.user`
 *    / `live.user`.
 *  - `triage.agent` / `audit.agent` — a short prose calibration note, learned
 *    by Claude from human-graded past cases (a hub learning job). Stored as
 *    JSON, unlike the other `.agent` prompts' plain prose.
 *
 * Project-specific content (the guidance text, informed by real feature/spec
 * names and failure signals) lives here and on the hub — never hard-coded
 * into ccqa itself.
 */

/**
 * One per-target overlay: the same learned-note fields as the top-level, minus
 * `basePromptVersion` (shared across the whole document — the base analysis
 * prompt is target-agnostic).
 */
export const AnalysisCustomPromptOverlaySchema = z.object({
  /** This overlay's own version — the per-target stratification key. */
  customPromptVersion: z.string(),
  generatedAt: z.string(),
  guidance: z.string(),
});
export type AnalysisCustomPromptOverlay = z.infer<typeof AnalysisCustomPromptOverlaySchema>;

export const AnalysisCustomPromptSchema = z.object({
  schemaVersion: z.literal(1),
  /** ANALYSIS_PROMPT_VERSION this custom prompt was built against. */
  basePromptVersion: z.string(),
  /** Custom prompt's own version — the stratification key for accuracy tracking. */
  customPromptVersion: z.string(),
  generatedAt: z.string(),
  /**
   * Claude-written calibration note. When `byTarget` is present, this is the
   * un-scoped FALLBACK note (learned from graded cases that carried no target),
   * used for any target without its own overlay. May be empty when every graded
   * case had a target — an empty note injects nothing (buildCustomPromptBlock).
   */
  guidance: z.string(),
  /**
   * Per-target overlays keyed by generation target ("agent-browser",
   * "playwright", ...). A run's failure analysis uses the entry matching the
   * spec's target and falls back to the top-level note otherwise. Optional so
   * blobs written before per-target scoping stay valid — they're all fallback.
   */
  byTarget: z.record(z.string(), AnalysisCustomPromptOverlaySchema).optional(),
});
export type AnalysisCustomPrompt = z.infer<typeof AnalysisCustomPromptSchema>;

/**
 * Lift one overlay into a standalone single-target `AnalysisCustomPrompt`: the
 * overlay's own note fields plus the document-wide `schemaVersion` /
 * `basePromptVersion`, and never a `byTarget` map. Passing the document itself
 * as the overlay yields the un-scoped top-level note as a clean single prompt.
 */
export function overlayAsPrompt(
  base: Pick<AnalysisCustomPrompt, "schemaVersion" | "basePromptVersion">,
  overlay: AnalysisCustomPromptOverlay,
): AnalysisCustomPrompt {
  return {
    schemaVersion: base.schemaVersion,
    basePromptVersion: base.basePromptVersion,
    customPromptVersion: overlay.customPromptVersion,
    generatedAt: overlay.generatedAt,
    guidance: overlay.guidance,
  };
}

/**
 * The effective single overlay for one target: its `byTarget` entry when it has
 * usable guidance, else the un-scoped top-level note when THAT has guidance,
 * else null. The returned value is a plain single-target `AnalysisCustomPrompt`
 * (no `byTarget`), so every downstream consumer — the prompt block and the
 * recorded `customPromptVersion` — sees exactly what was injected for the row.
 */
export function resolveCustomPromptForTarget(
  cp: AnalysisCustomPrompt | null | undefined,
  target: string,
): AnalysisCustomPrompt | null {
  if (!cp) return null;
  const scoped = cp.byTarget?.[target];
  if (scoped && scoped.guidance.trim()) return overlayAsPrompt(cp, scoped);
  if (cp.guidance.trim()) return overlayAsPrompt(cp, cp);
  return null;
}

/**
 * Render the custom prompt as a prompt section, or "" when there's nothing to add.
 * Returning "" for the empty/absent case is what keeps the base prompt
 * byte-for-byte identical when no custom prompt is supplied (backward compatibility).
 *
 * `promptName` picks the heading/wording for the side this block is injected
 * into — the run's `triage.agent` was graded from failures, the audit's
 * `audit.agent` from audits, and the block must not claim the wrong one.
 */
export function buildCustomPromptBlock(
  customPrompt: AnalysisCustomPrompt | null | undefined,
  promptName: LearnedPromptName = "triage.agent",
): string {
  if (!customPrompt || !customPrompt.guidance.trim()) return "";
  const subject = promptName === "audit.agent" ? "audit" : "failure";
  return `## Calibration guidance from human-graded past ${subject}s

This is a short note Claude learned from real, human-verified classifications
on this project. Treat it as calibration for this project's conventions — not
as a rule to copy verbatim; the current ${subject} may differ.

${customPrompt.guidance}
`;
}

/**
 * A graded triage case, flattened across runs, ready to feed a learning job.
 * `matches` is whether the model's prediction equalled the human call.
 */
export interface GradedCase {
  predicted: string;
  actualCause: ActualCause;
  evidenceSignal: string;
  matches: boolean;
  /**
   * Generation target of the graded row ("agent-browser", "playwright", ...),
   * or undefined for grades recorded before the target was tracked. The
   * learning job groups by this so one target's calibration never contaminates
   * another; undefined cases feed the un-scoped fallback note, not every target.
   */
  target?: string;
}

/**
 * Fetch a learned calibration prompt (`triage.agent` or `audit.agent`) from
 * the hub (best-effort). Returns null when there's no hub context, the hub
 * has no prompt stored, or the stored value fails to parse — a broken/missing
 * calibration prompt must never stop a run or audit.
 */
export async function fetchCustomPrompt(
  ctx: HubContext | null,
  name: LearnedPromptName = "triage.agent",
): Promise<AnalysisCustomPrompt | null> {
  if (!ctx) return null;
  // `getPrompt` answers null for a prompt that was never stored, so anything
  // thrown here is the hub itself being unreachable — which the caller must
  // hear about rather than run with silently different guidance.
  const raw = await ctx.hub.getPrompt(ctx.project, name);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // A corrupt/truncated blob is a data problem, not the transport failure
    // `.catch(asHubReadError)` callers report — surface it here so it isn't
    // silently mistaken for "nothing stored" either.
    log.warn(`hub prompt "${name}" (project "${ctx.project}") is not valid JSON, running without it: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const parsed = AnalysisCustomPromptSchema.safeParse(json);
  if (!parsed.success) {
    log.warn(`hub prompt "${name}" (project "${ctx.project}") does not match the expected shape, running without it`);
    return null;
  }
  return parsed.data;
}

/**
 * Render a human-maintained `.user` guidance prompt (`triage.user` or
 * `audit.user`) as a prompt section, or "" when there's nothing to add — same
 * backward-compatibility contract as `buildCustomPromptBlock`. It renders
 * BEFORE the learned calibration block (human standing guidance first,
 * learned calibration second), mirroring the user → agent order of the
 * record/live prompt bundles.
 *
 * `promptName` picks the heading and the prompt name named in the body, so an
 * `audit.user` block doesn't tell the audit its guidance came from the run's
 * `triage.user` prompt.
 */
export function buildTriageUserPromptBlock(
  text: string | null | undefined,
  promptName: UserPromptName = "triage.user",
): string {
  const trimmed = text?.trim();
  if (!trimmed) return "";
  const isAudit = promptName === "audit.user";
  const heading = isAudit ? "Project audit guidance" : "Project triage guidance";
  const subject = isAudit ? "the spec under audit" : "the failure at hand";
  return `## ${heading} (human-maintained)

Standing, project-specific classification guidance written by this project's
maintainers (the \`${promptName}\` hub prompt). Apply it where it speaks to
${subject}; the general rules above still hold where it is silent.

${trimmed}
`;
}

/**
 * Fetch a `.user` guidance prompt (`triage.user` or `audit.user`, plain
 * Markdown) from the hub. Same best-effort contract as `fetchCustomPrompt`:
 * no hub context, no stored prompt, an empty body, or a fetch failure all
 * resolve to null.
 */
export async function fetchTriageUserPrompt(
  ctx: HubContext | null,
  name: UserPromptName = "triage.user",
): Promise<string | null> {
  if (!ctx) return null;
  const raw = await ctx.hub.getPrompt(ctx.project, name);
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Short, stable content hash for a `.user` guidance prompt. The Markdown body
 * carries no version of its own (unlike `customPromptVersion`), so reports
 * record this hash as the stratification key for comparing accuracy across
 * guidance edits.
 */
export function hashTriageUserPrompt(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
