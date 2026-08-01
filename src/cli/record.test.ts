import { describe, expect, test, vi } from "vitest";
import { tallyInvocation, withCostTally } from "../claude/cost-tally.ts";
import type { ClaudeInvocationCost } from "../claude/invoke.ts";
import type { HubClient } from "../hub-client/index.ts";
import type { HubRunPush } from "./open-hub-run.ts";
import { sealRecordPush } from "./record.ts";

function fakePush(patchRun: HubClient["patchRun"]): HubRunPush {
  return { hub: { patchRun } as unknown as HubClient, kind: "record", runId: "r1", gitHead: "abc123" };
}

/** One Claude call, as `withCostReporting`'s tally would have seen it. */
const ONE_CALL: ClaudeInvocationCost = {
  totalCostUsd: 0.42,
  durationMs: null,
  durationApiMs: null,
  numTurns: 1,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: ["sonnet"],
};

describe("sealRecordPush", () => {
  test("a recording that died still leaves what it spent", async () => {
    // The hole this closes: a recording that died had already paid for its
    // Claude calls, and left nothing on the hub for a budget to count.
    const patchRun = vi.fn().mockResolvedValue({});
    await withCostTally(async () => {
      tallyInvocation(ONE_CALL);
      await sealRecordPush(fakePush(patchRun), "tasks", "create", false);
    });

    expect(patchRun).toHaveBeenCalledTimes(1);
    const [id, body] = patchRun.mock.calls[0]!;
    expect(id).toBe("r1");
    expect(body.done).toBe(true);
    expect(body.reportMeta.cost.totalCostUsd).toBe(0.42);
    expect(body.rows).toEqual([expect.objectContaining({ feature: "tasks", spec: "create", status: "failed" })]);
  });

  test("a recording that finished seals as passed", async () => {
    const patchRun = vi.fn().mockResolvedValue({});
    await sealRecordPush(fakePush(patchRun), "tasks", "create", true);
    expect(patchRun.mock.calls[0]![1].rows[0].status).toBe("passed");
  });
});
