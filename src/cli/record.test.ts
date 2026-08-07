import { describe, expect, test, vi } from "vitest";
import { tallyInvocation, withCostTally } from "../claude/cost-tally.ts";
import type { ClaudeInvocationCost } from "../claude/invoke.ts";
import type { HubClient } from "../hub-client/index.ts";
import type { HubRunPush } from "./open-hub-run.ts";
import type { RunTraceResult } from "./trace.ts";
import { abortNote, learnFromTrace, parseTimeoutSeconds, recordCommand, sealRecordPush } from "./record.ts";

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

  test("a failed seal answers false instead of exiting", async () => {
    // It runs as a teardown finalizer: exiting here would skip the
    // browser-session reap queued behind it. The caller sets the exit code.
    const patchRun = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(sealRecordPush(fakePush(patchRun), "tasks", "create", true)).resolves.toBe(false);
  });

  test("a failure note lands in the row's failureLogExcerpt", async () => {
    // The hole this closes: a CI wrapper's `timeout` SIGTERMs a stuck
    // recording, and the hub row said only status:"failed" — undiagnosable.
    const patchRun = vi.fn().mockResolvedValue({});
    await sealRecordPush(fakePush(patchRun), "tasks", "create", false, "terminated by signal (SIGTERM) during step-03");
    expect(patchRun.mock.calls[0]![1].rows[0]).toMatchObject({
      status: "failed",
      failureLogExcerpt: "terminated by signal (SIGTERM) during step-03",
    });
  });

  test("a note never captions a successful recording", async () => {
    const patchRun = vi.fn().mockResolvedValue({});
    await sealRecordPush(fakePush(patchRun), "tasks", "create", true, "terminated by signal (SIGTERM)");
    expect(patchRun.mock.calls[0]![1].rows[0]).toMatchObject({ status: "passed", failureLogExcerpt: null });
  });
});

describe("record --instruction", () => {
  test("parses the flag into opts.instruction, and leaves it undefined when absent", () => {
    expect(recordCommand.opts().instruction).toBeUndefined();
    recordCommand.parseOptions(["--instruction", "avoid asserting the results counter"]);
    expect(recordCommand.opts().instruction).toBe("avoid asserting the results counter");
  });
});

describe("record --timeout", () => {
  test("parses the flag into opts.timeout as a number, and leaves it undefined when absent", () => {
    expect(recordCommand.opts().timeout).toBeUndefined();
    recordCommand.parseOptions(["--timeout", "900"]);
    expect(recordCommand.opts().timeout).toBe(900);
  });

  test("rejects anything but a positive whole number of seconds", () => {
    expect(parseTimeoutSeconds("900")).toBe(900);
    for (const raw of ["0", "-5", "12.5", "abc", ""]) {
      expect(() => parseTimeoutSeconds(raw)).toThrow(/positive integer/);
    }
  });
});

describe("abortNote", () => {
  // Signal and --timeout share this one formatter, so a deadline death reads
  // exactly like a signal death on the hub row: cause + the step in flight.
  test("names the step in flight when one is", () => {
    expect(abortNote("timed out after 900s", "step-03")).toBe("timed out after 900s during step-03");
    expect(abortNote("terminated by signal (SIGTERM)", "step-01")).toBe(
      "terminated by signal (SIGTERM) during step-01",
    );
  });

  test("is just the cause when no step is tracing", () => {
    expect(abortNote("timed out after 900s")).toBe("timed out after 900s");
  });
});

describe("seal with a deadline note", () => {
  test("a timed-out recording's reason lands in failureLogExcerpt", async () => {
    const patchRun = vi.fn().mockResolvedValue({});
    await sealRecordPush(fakePush(patchRun), "tasks", "create", false, abortNote("timed out after 900s", "step-03"));
    expect(patchRun.mock.calls[0]![1].rows[0]).toMatchObject({
      status: "failed",
      failureLogExcerpt: "timed out after 900s during step-03",
    });
  });
});

/** Minimal completed-trace result — what any record path that traced holds. */
function traceResult(): RunTraceResult {
  return {
    status: "passed",
    statusLines: [],
    actionsKept: 0,
    actionsRecorded: 0,
    actions: [],
    churnByStep: new Map(),
  };
}

describe("learnFromTrace", () => {
  test("a trace ran → learning fires, whatever the rest of record does", async () => {
    // The hole this closes: learning was sequenced after generate + auto-fix,
    // so a death in that half silently discarded a completed trace's
    // learnings and no record.agent prompt ever appeared on the hub.
    const update = vi.fn().mockResolvedValue(undefined);
    const fired = await learnFromTrace(
      { enabled: true, featureName: "tasks", specName: "create", traceResult: traceResult(), hubContext: null },
      update,
    );
    expect(fired).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      kind: "record",
      flag: "--learn-hub-trace-prompt",
      runSummary: expect.stringContaining("tasks/create"),
    });
  });

  test("no trace ran → learning stays silent", async () => {
    const update = vi.fn();
    const fired = await learnFromTrace(
      { enabled: true, featureName: "tasks", specName: "create", traceResult: null, hubContext: null },
      update,
    );
    expect(fired).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  test("flag off → learning stays silent even when a trace ran", async () => {
    const update = vi.fn();
    const fired = await learnFromTrace(
      { enabled: false, featureName: "tasks", specName: "create", traceResult: traceResult(), hubContext: null },
      update,
    );
    expect(fired).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
