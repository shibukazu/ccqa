import { describe, expect, test } from "vitest";
import { formatLiveCost } from "./live-cost-format.ts";
import type { ReportCost } from "../report/schema.ts";

const EMPTY: ReportCost = {
  totalCostUsd: null,
  durationApiMs: null,
  numTurns: null,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: [],
};

describe("formatLiveCost", () => {
  test("nothing reported means no line", () => {
    expect(formatLiveCost(EMPTY, { compact: false })).toBeNull();
  });

  // An Anthropic-compatible gateway in front of a third-party model returns
  // usage but no price, because the SDK has no pricing table for it. Dropping
  // the line there would hide real consumption behind silence.
  test("usage without a price still reports what was consumed", () => {
    const line = formatLiveCost(
      { ...EMPTY, numTurns: 4, inputTokens: 42, outputTokens: 6511, models: ["kimi-k2"] },
      { compact: false },
    );
    expect(line).toBe("4 turns / 42+6511 tokens / model=kimi-k2");
  });

  test("a priced invocation leads with the price", () => {
    const line = formatLiveCost(
      { ...EMPTY, totalCostUsd: 1.5, numTurns: 4, models: ["sonnet"] },
      { compact: false },
    );
    expect(line).toBe("$1.5000 / 4 turns / model=sonnet");
  });
});
