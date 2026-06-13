import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Probe whether the host has any credential the Anthropic SDK can pick up:
 *   1. ANTHROPIC_API_KEY env var (CI / scripted use)
 *   2. ~/.claude/.credentials.json (Claude Code login, file-based platforms)
 *   3. macOS Keychain item "Claude Code-credentials" (Claude Code login on
 *      darwin stores the OAuth credentials in the Keychain, not on disk)
 *
 * Claude-driven hooks are opt-in, so the caller only consults this after the
 * user has asked for analysis. We never throw — auth absence is a normal flow
 * that surfaces as "analysis skipped".
 */
export function driftAuthAvailable(): { ok: true } | { ok: false; reason: string } {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (typeof key === "string" && key.length > 0) return { ok: true };
  const credPath = join(homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) return { ok: true };
  if (process.platform === "darwin" && keychainHasClaudeCredentials()) return { ok: true };
  return { ok: false, reason: "no ANTHROPIC_API_KEY / claude login" };
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
