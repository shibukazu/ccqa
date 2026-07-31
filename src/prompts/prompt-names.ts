import { join } from "node:path";

/**
 * The fixed set of prompt assets the hub stores per project/profile, and which
 * each is fetched at run time by the CLI. Kept as a tiny, dependency-free
 * module so both the hub side (store/handlers) and the client/CLI can share
 * the names without a circular import.
 *
 * Two kinds share one namespace:
 *  - "guidance": Markdown — every `.user.md` file, plus the record/live/
 *    playwright/runn `.agent.md` notes (despite the "agent" name, these are
 *    plain prose, not the learned JSON below).
 *  - "custom-prompt": JSON Claude writes — only `triage.agent` and
 *    `audit.agent`, calibration distilled from graded cases and injected at
 *    run time.
 *
 * `triage.*` belongs to `ccqa run`'s failure classification and `audit.*` to
 * `ccqa audit`. They are two prompts because they answer two questions in one
 * shared vocabulary: the audit decides whether a spec still describes the
 * code (from the source alone), and the run decides why it failed, using the
 * execution evidence — the two commands run independently, neither gating the
 * other (ADR-0016).
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
  "playwright.user",
  "playwright.agent",
  "runn.user",
  "runn.agent",
  "triage.user",
  "triage.agent",
  "audit.user",
  "audit.agent",
] as const;

/**
 * The `<kind>.user` / `<kind>.agent` guidance pairs above. Each generation
 * flow loads its own pair (`loadPromptBundleFromHub`): record/live for the
 * agent-browser flows, one pair per LLM-generation target otherwise.
 *
 * "triage" and "audit" are deliberately NOT guidance kinds: they are prompts a
 * command injects, not bundles a generation flow loads.
 */
export const GUIDANCE_KINDS = ["record", "live", "playwright", "runn"] as const;

export type GuidanceKind = (typeof GUIDANCE_KINDS)[number];

export type PromptName = (typeof PROMPT_NAMES)[number];

/** True for a value that is one of the reserved prompt names. */
export function isPromptName(value: string): value is PromptName {
  return (PROMPT_NAMES as readonly string[]).includes(value);
}

/**
 * Which of the two kinds a name belongs to (drives UI grouping and meta).
 * Read off the local path so the extension and the kind cannot disagree.
 */
export function promptKind(name: PromptName): "guidance" | "custom-prompt" {
  return PROMPT_LOCAL_PATHS[name].endsWith(".json") ? "custom-prompt" : "guidance";
}

/** Local path (relative to a `.ccqa` tree) each hub prompt restores to. */
export const PROMPT_LOCAL_PATHS: Record<PromptName, string> = {
  "record.user": ".ccqa/prompts/record.user.md",
  "record.agent": ".ccqa/prompts/record.agent.md",
  "live.user": ".ccqa/prompts/live.user.md",
  "live.agent": ".ccqa/prompts/live.agent.md",
  "playwright.user": ".ccqa/prompts/playwright.user.md",
  "playwright.agent": ".ccqa/prompts/playwright.agent.md",
  "runn.user": ".ccqa/prompts/runn.user.md",
  "runn.agent": ".ccqa/prompts/runn.agent.md",
  "triage.user": ".ccqa/prompts/triage.user.md",
  "triage.agent": ".ccqa/prompts/triage.agent.json",
  "audit.user": ".ccqa/prompts/audit.user.md",
  "audit.agent": ".ccqa/prompts/audit.agent.json",
};

/** Absolute local path a hub prompt pulls down to, under `cwd` (default `process.cwd()`). */
export function resolvePromptLocalPath(name: PromptName, cwd?: string): string {
  return join(cwd ?? process.cwd(), PROMPT_LOCAL_PATHS[name]);
}
