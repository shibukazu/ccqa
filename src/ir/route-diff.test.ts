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
