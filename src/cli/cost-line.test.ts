import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tallyInvocation, withCostTally } from "../claude/cost-tally.ts";
import { reportCost, withCostReporting } from "./cost-line.ts";

const ONE_CALL = {
  totalCostUsd: 1.5,
  durationMs: null,
  durationApiMs: null,
  numTurns: 3,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: ["sonnet"],
};

describe("CCQA_COST_FILE", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-cost-file-"));
  });
  afterEach(async () => {
    delete process.env.CCQA_COST_FILE;
    await rm(dir, { recursive: true, force: true });
  });

  test("appends a line per invocation, including unbilled ones", async () => {
    // One CI job runs several ccqa commands against the same file, so the
    // second must not truncate the first — the sum is the whole point.
    process.env.CCQA_COST_FILE = join(dir, "cost.jsonl");

    await withCostTally(async () => {
      tallyInvocation(ONE_CALL);
      reportCost("select-specs");
    });
    await withCostTally(async () => {
      reportCost("run");
    });

    expect(await recorded()).toEqual([
      ["select-specs", 1.5],
      ["run", null],
    ]);
  });

  // The wrapper is what puts the other eight commands inside a scope at all,
  // and it reports from two places (a `finally` and an `exit` listener) so
  // that a command ending in `process.exit` is still counted. Exactly one of
  // them must fire, or a job's total silently double-counts.
  test("withCostReporting reports once for a command that returns normally", async () => {
    process.env.CCQA_COST_FILE = join(dir, "cost.jsonl");

    const returned = await withCostReporting("audit", async () => {
      tallyInvocation(ONE_CALL);
      return "done";
    });

    expect(returned).toBe("done");
    expect(await recorded()).toEqual([["audit", 1.5]]);
  });

  async function recorded(): Promise<[string, number | null][]> {
    const raw = await readFile(process.env.CCQA_COST_FILE!, "utf8");
    return raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { command: string; totalCostUsd: number | null })
      .map((l) => [l.command, l.totalCostUsd]);
  }
});
