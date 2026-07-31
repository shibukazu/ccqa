import { AsyncLocalStorage } from "node:async_hooks";
import type { ClaudeInvocationCost } from "./invoke.ts";

/**
 * Sum every Claude invocation made inside a scope.
 *
 * A command like `record` calls Claude several times — the browser trace, the
 * codegen cleanup, one diagnosis per auto-fix retry — and the caller wants one
 * number for the whole command. Threading a cost out of each of those return
 * types would touch every layer in between, so the tally is scoped instead:
 * `invokeClaudeStreaming` adds to whichever scope is active, and nothing
 * between the two has to know.
 *
 * Scoped rather than module-global because commands run specs concurrently
 * (`drift` uses a pool). Two scopes must not fold into each other.
 */
const tallyStore = new AsyncLocalStorage<ClaudeInvocationCost[]>();

/** Record one invocation against the active scope. No-op outside one. */
export function tallyInvocation(cost: ClaudeInvocationCost): void {
  tallyStore.getStore()?.push(cost);
}

/** Run `fn` with a fresh tally. Read the total from inside with `readCostTally`. */
export async function withCostTally<T>(fn: () => Promise<T>): Promise<T> {
  return tallyStore.run([], fn);
}

/**
 * The active scope's total so far, or null outside one.
 *
 * Read rather than pushed at the caller because commands end in
 * `process.exit`, which never reaches a `finally`; whoever opened the scope
 * reads the total on the way out (see `withCostReporting`).
 *
 * Fields stay `null` when no invocation reported them, so a caller can tell
 * "nothing was billed" from "the SDK didn't say" (mock runs, SDK errors).
 */
export function readCostTally(): ClaudeInvocationCost | null {
  const collected = tallyStore.getStore();
  return collected === undefined ? null : sum(collected);
}

function sum(costs: readonly ClaudeInvocationCost[]): ClaudeInvocationCost {
  const add = (pick: (c: ClaudeInvocationCost) => number | null): number | null => {
    const present = costs.map(pick).filter((v): v is number => v !== null);
    return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
  };
  return {
    totalCostUsd: add((c) => c.totalCostUsd),
    durationMs: add((c) => c.durationMs),
    durationApiMs: add((c) => c.durationApiMs),
    numTurns: add((c) => c.numTurns),
    inputTokens: add((c) => c.inputTokens),
    cacheCreationInputTokens: add((c) => c.cacheCreationInputTokens),
    cacheReadInputTokens: add((c) => c.cacheReadInputTokens),
    outputTokens: add((c) => c.outputTokens),
    models: [...new Set(costs.flatMap((c) => c.models))],
  };
}
