import type { LiveRunResult } from "./live-executor.ts";

type Cost = LiveRunResult["cost"];

/**
 * Compact one-line cost summary. Format:
 *   "$0.1234 · 4 turns · 42 in / 6,511 out · 2.0M cached · sonnet"
 * Returns null only when the invocation reported nothing at all (a mock run,
 * an SDK error, or a command that never called a model).
 *
 * The price is one segment among several, not a precondition. An endpoint the
 * SDK has no pricing table for — any Anthropic-compatible gateway in front of
 * a third-party model — reports usage but no `total_cost_usd`, and dropping
 * the whole line there would hide real consumption behind silence. Tokens come
 * from the API response rather than a price list, so they survive that case
 * and become the signal to read.
 *
 * `compact: false` (default for CLI logs) keeps raw numbers and adds a
 * `model=...` segment. `compact: true` (HTML chip) thousand-separates fresh
 * tokens, abbreviates cache-read with K/M, drops the `model=` prefix.
 */
export function formatLiveCost(cost: Cost, options: { compact: boolean }): string | null {
  const compact = options.compact;
  const sep = compact ? " · " : " / ";
  const parts: string[] = [];
  if (cost.totalCostUsd !== null) parts.push(`$${cost.totalCostUsd.toFixed(4)}`);
  if (cost.numTurns !== null) parts.push(`${cost.numTurns} turns`);
  if (cost.inputTokens !== null || cost.outputTokens !== null) {
    const i = cost.inputTokens ?? 0;
    const o = cost.outputTokens ?? 0;
    parts.push(
      compact
        ? `${formatNumber(i)} in / ${formatNumber(o)} out`
        : `${i}+${o} tokens`,
    );
  }
  if (cost.cacheReadInputTokens !== null && cost.cacheReadInputTokens > 0) {
    parts.push(
      compact
        ? `${formatTokenK(cost.cacheReadInputTokens)} cached`
        : `${cost.cacheReadInputTokens} cache-read`,
    );
  }
  if (!compact && cost.models.length > 0) parts.push(`model=${cost.models.join(",")}`);
  return parts.length > 0 ? parts.join(sep) : null;
}

/** Thousand-separated count for token figures. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Compact token count: 9,043,456 → "9.0M", 12000 → "12K", small → plain. */
export function formatTokenK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}
