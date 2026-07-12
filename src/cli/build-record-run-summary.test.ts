import { describe, expect, test } from "vitest";
import { buildRecordRunSummary } from "./record.ts";
import type { RunTraceResult } from "./trace.ts";
import type { ParsedStatusLine, RecordedAction } from "../types.ts";

function statusLines(stepId = "step-01"): ParsedStatusLine[] {
  return [
    { type: "STEP_START", stepId, detail: "fill the form" },
    { type: "STEP_DONE", stepId, detail: "email field shows the value" },
  ];
}

function action(overrides: Partial<RecordedAction> = {}): RecordedAction {
  return { action: "fill", locator: { by: "css", value: "#email" }, value: "x", ...overrides };
}

function traceResult(overrides: Partial<RunTraceResult> = {}): RunTraceResult {
  return {
    status: "passed",
    statusLines: statusLines(),
    actionsKept: 1,
    actionsRecorded: 1,
    actions: [action()],
    churnByStep: new Map(),
    ...overrides,
  };
}

describe("buildRecordRunSummary", () => {
  test("kept commands attach to the matching stepId", () => {
    const t = traceResult({
      actions: [action({ stepId: "step-01" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("- kept commands: fill #email = x");
  });

  test("step title, outcome, and result detail come from the status lines", () => {
    const t = traceResult({
      statusLines: [
        { type: "STEP_START", stepId: "step-01", detail: "fill the form" },
        { type: "STEP_DONE", stepId: "step-01", detail: "email field shows the value" },
      ],
      actions: [action({ stepId: "step-01" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("### step-01 — fill the form (DONE)");
    expect(summary).toContain("- result: email field shows the value");
  });

  test("a failed step carries the ASSERTION_FAILED detail", () => {
    const t = traceResult({
      status: "failed",
      statusLines: [
        { type: "STEP_START", stepId: "step-02", detail: "submit the form" },
        { type: "ASSERTION_FAILED", stepId: "step-02", detail: "app-bug: nothing happened" },
      ],
      actions: [],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("## checkout/happy-path — failed");
    expect(summary).toContain("### step-02 — submit the form (FAILED)");
    expect(summary).toContain("- result: app-bug: nothing happened");
  });

  test("per-action observations surface under their step", () => {
    const t = traceResult({
      actions: [
        action({ stepId: "step-01" }),
        { action: "snapshot", observation: "form rendered with two fields", stepId: "step-01" },
      ],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("- observations: form rendered with two fields");
  });

  test("selectors are kept verbatim (not masked)", () => {
    const t = traceResult({
      actions: [action({ stepId: "step-01" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("#email");
  });

  test("actions without a stepId are ignored", () => {
    const t = traceResult({
      actions: [action({ stepId: undefined, locator: { by: "css", value: "#orphan" } })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).not.toContain("#orphan");
    expect(summary).not.toContain("kept commands:");
  });

  test("empty status lines", () => {
    const t = traceResult({ statusLines: [] });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("(no step status lines recorded)");
  });

  test("a step that dropped attempts gets a churn line; a clean step does not", () => {
    const churned = traceResult({
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 5, kept: 2, redundant: 0 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", churned)).toContain(
      "- churn: 5 attempts → 2 kept (3 dropped)",
    );

    const clean = traceResult({
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 2, kept: 2, redundant: 0 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", clean)).not.toContain("- churn:");
  });

  test("a step with a field entered via 2+ selectors gets a redundant line", () => {
    const t = traceResult({
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 3, kept: 3, redundant: 1 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", t)).toContain(
      "- redundant: 1 field(s) entered via 2+ selectors",
    );
  });

  test("a replay-unstable kept action is tagged [unstable] and gets a per-step line", () => {
    const t = traceResult({
      actions: [
        action({
          stepId: "step-01",
          action: "assert",
          locator: { by: "css", value: "[aria-label='検索']" },
          assert: "element_visible",
          replayUnstable: true,
          replayReason: "selector not present within 10000ms",
        }),
      ],
      churnByStep: new Map([["step-01", { recorded: 1, kept: 1, redundant: 0 }]]),
    });
    const summary = buildRecordRunSummary("checkout", "happy-path", t);
    // The command carries the marker + reason so the learner won't record it.
    expect(summary).toContain("[unstable](selector not present within 10000ms)");
    // And the step gets a one-line warning above kept commands.
    expect(summary).toContain("- replay-unstable: 1 kept command(s) marked [unstable]");
  });

  test("a stable kept action gets no [unstable] marker or line", () => {
    const t = traceResult({
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 1, kept: 1, redundant: 0 }]]),
    });
    const summary = buildRecordRunSummary("checkout", "happy-path", t);
    expect(summary).not.toContain("[unstable]");
    expect(summary).not.toContain("- replay-unstable:");
  });
});
