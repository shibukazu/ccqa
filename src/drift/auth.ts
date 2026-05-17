import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Probe whether the host has any credential the Anthropic SDK can pick up:
 *   1. ANTHROPIC_API_KEY env var (CI / scripted use)
 *   2. ~/.claude/.credentials.json (local Claude Code login)
 *
 * `run --drift` is opt-in, so the caller will only consult this after the
 * user has asked for drift. We never throw — auth absence is a normal flow
 * that surfaces as "drift analysis skipped".
 */
export function driftAuthAvailable(): { ok: boolean; reason?: string } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (typeof key === "string" && key.length > 0) return { ok: true };
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) return { ok: true };
  return { ok: false, reason: "no ANTHROPIC_API_KEY / claude login" };
}
