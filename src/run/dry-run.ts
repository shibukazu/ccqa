import type { SpecWithMode } from "../cli/spec-mode.ts";
import { specKey } from "../store/index.ts";
import type { TargetDispatch } from "./target-dispatch.ts";

/**
 * The lines `ccqa run --dry-run` prints: one per selected spec, tagged with
 * what would have executed it.
 *
 * This exists because a selection can be wrong in a way that costs money.
 * `ccqa select-specs`'s model judgment is not infallible, and both
 * `--only-affected-by` and `--only-stale` decide from it, so a human has to
 * be able to read the selection back before a live spec spends a Claude
 * budget on it.
 *
 * Rows that would not have executed (a generate-only target, an unresolvable
 * one) are listed too, with their reason: they are part of what the selection
 * produced, and leaving them out would make the list look shorter than the
 * run's report will be.
 */
export function formatDryRunLines(
  agentBrowser: readonly SpecWithMode[],
  // Deliberately not the whole `TargetDispatch`: its own `agentBrowser` is the
  // pre-mode-resolution version of the first argument, and picking the wrong
  // one would silently label every spec "deterministic".
  routed: Pick<TargetDispatch, "external" | "skipped" | "unresolved">,
): string[] {
  const tagged: Array<{ key: string; tag: string }> = [
    ...agentBrowser.map((s) => ({ key: specKey(s), tag: s.mode })),
    ...routed.external.flatMap((g) => g.specs.map((s) => ({ key: specKey(s), tag: g.targetId }))),
    ...routed.skipped.map((s) => ({ key: specKey(s), tag: `skipped — ${s.reason}` })),
    ...routed.unresolved.map((s) => ({ key: specKey(s), tag: `unresolved — ${s.reason}` })),
  ];
  const width = Math.max(0, ...tagged.map((t) => t.key.length));
  return tagged.map((t) => `  ${t.key.padEnd(width)}  ${t.tag}`);
}
