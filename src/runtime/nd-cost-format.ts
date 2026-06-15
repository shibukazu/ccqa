import type { NdRunResult } from "./nd-executor.ts";

type Cost = NdRunResult["cost"];

/**
 * Compact one-line cost summary. Format:
 *   "$0.1234 · 4 turns · 42 in / 6,511 out · 2.0M cached · sonnet"
 * Returns null when no cost data is available (mock runs / SDK errors).
 *
 * `compact: false` (default for CLI logs) keeps raw numbers and adds a
 * `model=...` segment. `compact: true` (HTML chip) thousand-separates fresh
 * tokens, abbreviates cache-read with K/M, drops the `model=` prefix.
 */
export function formatNdCost(cost: Cost, options: { compact: boolean }): string | null {
  if (cost.totalCostUsd === null) return null;
  const compact = options.compact;
  const sep = compact ? " · " : " / ";
  const parts: string[] = [`$${cost.totalCostUsd.toFixed(4)}`];
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
  return parts.join(sep);
}

/**
 * Sum of per-spec costs for a batch. Used only by the CLI batch summary.
 * Returns null when no spec has cost data.
 */
export function formatNdBatchCost(costs: readonly Cost[]): string | null {
  let totalUsd = 0;
  let seen = false;
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheRead = 0;
  for (const c of costs) {
    if (c.totalCostUsd !== null) {
      totalUsd += c.totalCostUsd;
      seen = true;
    }
    totalIn += c.inputTokens ?? 0;
    totalOut += c.outputTokens ?? 0;
    totalCacheRead += c.cacheReadInputTokens ?? 0;
  }
  if (!seen) return null;
  const parts = [`$${totalUsd.toFixed(4)}`, `${totalIn}+${totalOut} tokens`];
  if (totalCacheRead > 0) parts.push(`${totalCacheRead} cache-read`);
  return parts.join(" / ");
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
