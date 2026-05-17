import { findStaleBlockArtifacts } from "../store/index.ts";
import * as log from "./logger.ts";

/**
 * Hint when stale per-block artifacts (`test.spec.ts`, `actions.json`,
 * `route.md`) from earlier ccqa versions are still present. v0.4 treats
 * blocks as pure spec templates — they no longer have their own executable
 * or recorded artifacts, so these files are dead code and should be deleted
 * manually. Shared by `trace` and `generate`.
 */
export async function warnStaleBlockArtifacts(): Promise<void> {
  const stale = await findStaleBlockArtifacts();
  if (stale.length === 0) return;
  for (const p of stale) {
    log.hint(`stale block artifact detected: ${p} — v0.4 no longer uses these; delete it manually.`);
  }
}
