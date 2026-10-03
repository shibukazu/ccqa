import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveAgentBrowserBin } from "../../../src/runtime/agent-browser-bin.ts";

/**
 * Whether a real browser can run here (not in CI). The gate is agent-browser's
 * own browser cache, because first use would otherwise download Chrome.
 */
export function realBrowserAvailable(): boolean {
  try {
    resolveAgentBrowserBin();
  } catch {
    return false;
  }
  return existsSync(join(homedir(), ".agent-browser", "browsers"));
}
