import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildLiveTranscriptExcerpt } from "./live-transcript-excerpt.ts";
import type { LiveRunResult, LiveStepResult } from "../runtime/live-executor.ts";

function makeStep(overrides: Partial<LiveStepResult>): LiveStepResult {
  return {
    stepId: "step-01",
    source: "spec",
    instruction: "do thing",
    expected: "thing happens",
    status: "passed",
    reasoning: "looked fine",
    beforePng: null,
    afterPng: null,
    logTxt: null,
    durationMs: 1000,
    cost: {
      totalCostUsd: null,
      durationApiMs: null,
      numTurns: null,
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
      models: [],
    },
    ...overrides,
  };
}

function makeRun(steps: LiveStepResult[]): LiveRunResult {
  return {
    runId: "test-run",
    status: steps.some((s) => s.status === "failed") ? "failed" : "passed",
    sessionName: "ccqa-test",
    startedAt: "2026-06-15T00:00:00.000Z",
    durationMs: 1000,
    steps,
    cost: {
      totalCostUsd: null,
      durationApiMs: null,
      numTurns: null,
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: null,
      models: [],
    },
  };
}

describe("buildLiveTranscriptExcerpt", () => {
  test("returns null when the run has no failed step", async () => {
    const run = makeRun([makeStep({ stepId: "step-01", status: "passed" })]);
    expect(await buildLiveTranscriptExcerpt(run)).toBeNull();
  });

  test("summarises previous-passed steps and inlines the failing step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-live-excerpt-"));
    const failLog = join(dir, "step-02.log.txt");
    await writeFile(failLog, "Claude tried selector A\nselector A missing\nSTEP_RESULT|step-02|fail|selector A missing", "utf-8");

    const run = makeRun([
      makeStep({ stepId: "step-01", status: "passed", reasoning: "login form rendered" }),
      makeStep({
        stepId: "step-02",
        status: "failed",
        reasoning: "selector A missing",
        instruction: "click submit",
        expected: "redirect to dashboard",
        logTxt: failLog,
      }),
    ]);
    const excerpt = await buildLiveTranscriptExcerpt(run);
    expect(excerpt).toContain("[step-01 passed: login form rendered]");
    expect(excerpt).toContain(">>> Failed step step-02");
    expect(excerpt).toContain("Instruction: click submit");
    expect(excerpt).toContain("Expected: redirect to dashboard");
    expect(excerpt).toContain("selector A missing");
  });

  test("trims the assistant log to head + tail when oversized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-live-excerpt-"));
    const failLog = join(dir, "step-01.log.txt");
    const big = "A".repeat(15000) + "MIDDLE" + "B".repeat(15000);
    await writeFile(failLog, big, "utf-8");

    const run = makeRun([
      makeStep({ stepId: "step-01", status: "failed", reasoning: "boom", logTxt: failLog }),
    ]);
    const excerpt = await buildLiveTranscriptExcerpt(run, { headBytes: 100, tailBytes: 100 });
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThan(big.length);
    expect(excerpt).toContain("--- assistant log (head 100B) ---");
    expect(excerpt).toContain("--- assistant log (tail 100B) ---");
    expect(excerpt).toMatch(/\[\d{4,} bytes omitted\]/);
    expect(excerpt).not.toContain("MIDDLE");
  });

  test("notes subsequent skipped steps so the classifier sees the run aborted", async () => {
    const run = makeRun([
      makeStep({ stepId: "step-01", status: "passed", reasoning: "ok" }),
      makeStep({ stepId: "step-02", status: "failed", reasoning: "broke" }),
      makeStep({ stepId: "step-03", status: "skipped", reasoning: "earlier step failed" }),
      makeStep({ stepId: "step-04", status: "skipped", reasoning: "earlier step failed" }),
    ]);
    const excerpt = await buildLiveTranscriptExcerpt(run);
    expect(excerpt).toContain("[2 subsequent step(s) skipped because step-02 failed]");
  });

  test("respects the overall maxBytes cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-live-excerpt-"));
    const failLog = join(dir, "step-01.log.txt");
    await writeFile(failLog, "X".repeat(50000), "utf-8");
    const run = makeRun([
      makeStep({ stepId: "step-01", status: "failed", reasoning: "fail", logTxt: failLog }),
    ]);
    const excerpt = await buildLiveTranscriptExcerpt(run, {
      headBytes: 20000,
      tailBytes: 20000,
      maxBytes: 500,
    });
    expect(excerpt!.length).toBeLessThanOrEqual(600);
    expect(excerpt).toContain("transcript excerpt truncated at 500 bytes");
  });
});
