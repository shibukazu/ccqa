import type { CapabilitySupport } from "../types.ts";

/**
 * Lives apart from the plugin so the paths that refuse a claim can read the
 * same declaration the plugin publishes, without importing the plugin they
 * are part of.
 */
export const AGENT_BROWSER_JUDGE_STEPS = {
  supported: false,
  reason: "it drives a browser through a model, whose `expected` already decides each step",
} as const satisfies CapabilitySupport;
