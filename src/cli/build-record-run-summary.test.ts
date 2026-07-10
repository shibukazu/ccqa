import { describe, expect, test } from "vitest";
import { buildRecordRunSummary } from "./record.ts";
import type { RunTraceResult } from "./trace.ts";
import type { Route, RouteStep, TraceAction } from "../types.ts";

function step(overrides: Partial<RouteStep> = {}): RouteStep {
  return {
    title: "fill the form",
    action: "filled the email field",
    observation: "email field shows the value",
    status: "PASSED",
    ...overrides,
  };
}

function route(overrides: Partial<Route> = {}): Route {
  return {
    specName: "happy-path",
    timestamp: "2020-01-01T00:00:00.000Z",
    status: "passed",
    steps: [step()],
    ...overrides,
  };
}

function action(overrides: Partial<TraceAction> = {}): TraceAction {
  return { command: "fill", selector: "#email", value: "x", ...overrides };
}

function traceResult(overrides: Partial<RunTraceResult> = {}): RunTraceResult {
  return {
    route: route(),
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
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("- kept commands: fill #email = x");
  });

  test("selectors are kept verbatim (not masked)", () => {
    const t = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01", selector: "#email" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("#email");
  });

  test("actions without a stepId are ignored", () => {
    const t = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: undefined, selector: "#orphan" })],
    });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).not.toContain("#orphan");
    expect(summary).not.toContain("kept commands:");
  });

  test("empty route.steps", () => {
    const t = traceResult({ route: route({ steps: [] }) });

    const summary = buildRecordRunSummary("checkout", "happy-path", t);

    expect(summary).toContain("(no route steps recorded)");
  });

  test("a step that dropped attempts gets a churn line; a clean step does not", () => {
    const churned = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 5, kept: 2, redundant: 0 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", churned)).toContain(
      "- churn: 5 attempts → 2 kept (3 dropped)",
    );

    const clean = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 2, kept: 2, redundant: 0 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", clean)).not.toContain("- churn:");
  });

  test("a step with a field entered via 2+ selectors gets a redundant line", () => {
    const t = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 3, kept: 3, redundant: 1 }]]),
    });
    expect(buildRecordRunSummary("checkout", "happy-path", t)).toContain(
      "- redundant: 1 field(s) entered via 2+ selectors",
    );
  });

  test("a replay-unstable kept action is tagged [unstable] and gets a per-step line", () => {
    const t = traceResult({
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [
        action({
          stepId: "step-01",
          command: "assert",
          selector: "[aria-label='検索']",
          assertType: "element_visible",
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
      route: route({ steps: [step({ stepId: "step-01" })] }),
      actions: [action({ stepId: "step-01" })],
      churnByStep: new Map([["step-01", { recorded: 1, kept: 1, redundant: 0 }]]),
    });
    const summary = buildRecordRunSummary("checkout", "happy-path", t);
    expect(summary).not.toContain("[unstable]");
    expect(summary).not.toContain("- replay-unstable:");
  });
});
