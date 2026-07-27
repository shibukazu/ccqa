import { describe, expect, test } from "vitest";
import { readCostTally, tallyInvocation, withCostTally } from "./cost-tally.ts";
import type { ClaudeInvocationCost } from "./invoke.ts";

const cost = (over: Partial<ClaudeInvocationCost> = {}): ClaudeInvocationCost => ({
  totalCostUsd: null,
  durationMs: null,
  durationApiMs: null,
  numTurns: null,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: [],
  ...over,
});

describe("cost tally", () => {
  test("a field only some invocations reported still sums those", async () => {
    // The distinction that matters: "nobody reported this" must stay null, but
    // one silent invocation must not null out the ones that did report.
    await withCostTally(async () => {
      tallyInvocation(cost({ totalCostUsd: 0.5, numTurns: 3, models: ["haiku"] }));
      tallyInvocation(cost({ models: ["haiku"] }));
      tallyInvocation(cost({ totalCostUsd: 0.25, numTurns: 1, models: ["sonnet"] }));
      expect(readCostTally()).toMatchObject({
        totalCostUsd: 0.75,
        numTurns: 4,
        inputTokens: null,
        models: ["haiku", "sonnet"],
      });
    });
  });

  test("invocations outside a scope are dropped rather than leaking into the next one", async () => {
    tallyInvocation(cost({ totalCostUsd: 99 }));
    expect(readCostTally()).toBeNull();
    await withCostTally(async () => {
      expect(readCostTally()).toMatchObject({ totalCostUsd: null });
    });
  });
});
