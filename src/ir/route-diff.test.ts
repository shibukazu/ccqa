import { describe, expect, it } from "vitest";
import { diffRoutes, renderRouteDiff } from "./route-diff.ts";
import type { RecordedAction } from "./types.ts";

const before: RecordedAction[] = [
  { action: "navigate", value: "${BASE_URL}/todos", stepId: "step-01" },
  { action: "click", locator: { by: "text", value: "Submit" }, label: "Submit", stepId: "step-02" },
  { action: "assert", assert: "text_visible", value: "Saved", stepId: "step-02" },
];

describe("diffRoutes", () => {
  it("reports a re-addressed operation as changed, not as a removal plus an addition", () => {
    const after: RecordedAction[] = [
      before[0]!,
      {
        action: "click",
        locator: { by: "role", value: "button", name: "Submit" },
        label: "Submit",
        stepId: "step-02",
      },
      before[2]!,
    ];
    expect(diffRoutes(before, after)).toEqual({
      changes: [
        {
          kind: "changed",
          step: "step-02",
          before: 'click text="Submit"',
          after: 'click role=button[name="Submit"]',
        },
      ],
      moved: [],
      unchangedSteps: ["step-01"],
    });
  });

  it("reports added and removed actions against the step they belong to", () => {
    const after: RecordedAction[] = [
      before[0]!,
      before[1]!,
      { action: "assert", assert: "text_visible", value: "Saved to your list", stepId: "step-02" },
      { action: "click", locator: { by: "text", value: "Close" }, label: "Close", stepId: "step-02" },
    ];
    expect(diffRoutes(before, after).changes).toEqual([
      {
        kind: "changed",
        step: "step-02",
        before: 'assert text_visible "Saved"',
        after: 'assert text_visible "Saved to your list"',
      },
      { kind: "added", step: "step-02", after: 'click text="Close"' },
    ]);
  });

  it("says so when nothing moved", () => {
    const markdown = renderRouteDiff(diffRoutes(before, before), {
      specKey: "todos/create",
      before: { recordedAt: "2026-01-01T00:00:00.000Z", actions: before },
      after: { recordedAt: "2026-02-01T00:00:00.000Z", actions: before },
    });
    expect(markdown).toContain("The route is unchanged");
  });
});

describe("diffRoutes — an operation recorded under a different step", () => {
  // Measured on a re-record: most of a 33-entry diff was a sign-in the
  // recorder put inside the first step this time and before it last time.
  // Reported as removals and additions, it describes a flow nobody touched.
  const signIn: RecordedAction = {
    action: "fill",
    locator: { by: "label", value: "Email" },
    value: "${TEST_EMAIL}",
  };
  const open: RecordedAction = { action: "navigate", value: "https://example.test/", stepId: "step-01" };

  it("folds a move into its own list instead of a removal plus an addition", () => {
    const diff = diffRoutes([{ ...signIn }, open], [{ ...signIn, stepId: "step-01" }, open]);
    expect(diff.changes).toEqual([]);
    expect(diff.moved).toEqual([
      { action: 'fill label="Email" "${TEST_EMAIL}"', from: "(no step)", to: "step-01" },
    ]);
  });

  // Telling which of two identical operations moved is a question the
  // recording cannot answer, so the per-step diff keeps them.
  it("leaves a repeated operation to the per-step diff", () => {
    const twice = [{ ...signIn }, { ...signIn }];
    const diff = diffRoutes(twice, twice.map((a) => ({ ...a, stepId: "step-01" })));
    expect(diff.moved).toEqual([]);
    expect(diff.changes.length).toBeGreaterThan(0);
  });

  it("says the route is unchanged when only attribution moved", () => {
    const diff = diffRoutes([{ ...signIn }], [{ ...signIn, stepId: "step-01" }]);
    const markdown = renderRouteDiff(diff, {
      specKey: "demo/x",
      before: { actions: [] },
      after: { actions: [] },
    });
    expect(markdown).toContain("Only which step each was recorded under moved");
    expect(markdown).toContain("Recorded under a different step");
  });
});

