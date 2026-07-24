import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code can also run against AWS Bedrock / Google Vertex AI, selected by
 * these env toggles. Credentials then come from the cloud SDK's own chain
 * (instance/task roles, gcloud auth, …), so none of the Anthropic-side probes
 * below apply — a set toggle counts as auth being available. ccqa forwards the
 * toggle verbatim; only "0"/"false" (any case) is treated as explicitly off.
 */
const CLOUD_PROVIDER_ENV_KEYS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

function cloudProviderEnabled(): boolean {
  return CLOUD_PROVIDER_ENV_KEYS.some((key) => {
    const value = process.env[key]?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
  });
}

/**
 * Probe whether the host has any credential the Anthropic SDK can pick up:
 *   1. ANTHROPIC_API_KEY env var (CI / scripted use)
 *   2. CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX (cloud-provider
 *      endpoints authenticated by the cloud SDK's credential chain)
 *   3. ~/.claude/.credentials.json (Claude Code login, file-based platforms)
 *   4. macOS Keychain item "Claude Code-credentials" (Claude Code login on
 *      darwin stores the OAuth credentials in the Keychain, not on disk)
 *
 * Claude-driven hooks are opt-in, so the caller only consults this after the
 * user has asked for analysis. We never throw — auth absence is a normal flow
 * that surfaces as "analysis skipped".
 */
export function driftAuthAvailable(): { ok: true } | { ok: false; reason: string } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (typeof key === "string" && key.length > 0) return { ok: true };
  if (cloudProviderEnabled()) return { ok: true };
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) return { ok: true };
  if (process.platform === "darwin" && keychainHasClaudeCredentials()) return { ok: true };
  return { ok: false, reason: "no ANTHROPIC_API_KEY / Bedrock or Vertex env / claude login" };
}

/**
 * `security find-generic-password` without `-w` only checks the item's
 * existence (exit 0) — it never reads the secret, so no Keychain unlock
 * prompt is triggered. Resolved via PATH so tests can stub the binary.
 */
function keychainHasClaudeCredentials(): boolean {
  try {
    const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], {
      stdio: "ignore",
      timeout: 3000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}
