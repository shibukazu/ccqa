import { describe, expect, test } from "vitest";
import { buildLiveRunSummary } from "./pipeline.ts";
import type { LiveReportCost, LiveReportStep, ReportSpecResult } from "../report/schema.ts";

function cost(overrides: Partial<LiveReportCost> = {}): LiveReportCost {
  return {
    totalCostUsd: 0.0123,
    durationApiMs: 1000,
    numTurns: 5,
    inputTokens: 100,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 50,
    models: ["claude"],
    ...overrides,
  };
}

function step(overrides: Partial<LiveReportStep> = {}): LiveReportStep {
  return {
    stepId: "step-1",
    source: "spec.yaml",
    instruction: "click submit",
    expected: "form is submitted",
    status: "passed",
    reasoning: "clicked the button and confirmed the toast",
    beforePng: null,
    afterPng: null,
    durationMs: 2500,
    cost: cost(),
    ...overrides,
  };
}

function specResult(overrides: Partial<ReportSpecResult> = {}): ReportSpecResult {
  return {
    feature: "checkout",
    spec: "happy-path",
    title: null,
    status: "passed",
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
    ...overrides,
  };
}

describe("buildLiveRunSummary", () => {
  test("shows a commands line (and expected) for a step at/above the turn threshold with commands", () => {
    const result = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [step({ cost: cost({ numTurns: 5 }), commands: ["click #submit", "wait 200"] })],
        cost: cost({ numTurns: 5 }),
      },
    });

    const summary = buildLiveRunSummary([result]);

    expect(summary).toContain("click #submit ; wait 200");
    expect(summary).toContain("commands (snapshot refs masked");
    expect(summary).toContain("expected: form is submitted");
    // Leads with the instruction; the step id is demoted to a trailing tag.
    expect(summary).toContain("- [passed] click submit (5 turns, 2.5s, $0.012, step-1):");
  });

  test("masks per-run snapshot refs (@eN) in the commands so the learner can't reuse them", () => {
    const result = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [step({ cost: cost({ numTurns: 5 }), commands: ['click "@e4"', 'keyboard inserttext foo'] })],
        cost: cost({ numTurns: 5 }),
      },
    });

    const summary = buildLiveRunSummary([result]);

    expect(summary).toContain('click "@ref"');
    expect(summary).not.toContain("@e4");
  });

  test("strips the per-run --session flag so the learner can't paste a dead session id", () => {
    const result = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [
          step({
            cost: cost({ numTurns: 5 }),
            commands: ["agent-browser snapshot --session ccqa-live-2026-07-09T17-27-37-173Z-42550542"],
          }),
        ],
        cost: cost({ numTurns: 5 }),
      },
    });

    const summary = buildLiveRunSummary([result]);

    expect(summary).toContain("agent-browser snapshot");
    expect(summary).not.toContain("--session");
    expect(summary).not.toContain("ccqa-live-2026");
  });

  test("omits the commands line when numTurns is below the shortcut threshold", () => {
    const result = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [step({ cost: cost({ numTurns: 1 }), commands: ["click #submit"] })],
        cost: cost({ numTurns: 1 }),
      },
    });

    const summary = buildLiveRunSummary([result]);

    expect(summary).not.toContain("commands:");
  });

  test("omits the commands line when commands is empty or missing", () => {
    const withEmpty = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [step({ cost: cost({ numTurns: 5 }), commands: [] })],
        cost: cost({ numTurns: 5 }),
      },
    });
    const withoutCommands = specResult({
      liveRun: {
        runId: "run-1",
        sessionName: "session",
        startedAt: "2020-01-01T00:00:00.000Z",
        durationMs: 3000,
        steps: [step({ cost: cost({ numTurns: 5 }) })],
        cost: cost({ numTurns: 5 }),
      },
    });

    expect(buildLiveRunSummary([withEmpty])).not.toContain("commands:");
    expect(buildLiveRunSummary([withoutCommands])).not.toContain("commands:");
  });

  test("skips results with no liveRun, and reports a fallback when none executed", () => {
    const detResult = specResult({ liveRun: null });

    expect(buildLiveRunSummary([detResult])).toBe("(no live runs executed)");
    expect(buildLiveRunSummary([])).toBe("(no live runs executed)");
  });
});
