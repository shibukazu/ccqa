import { describe, expect, test } from "vitest";
import {
  cleanupReplayWarning,
  judgeReplayedRoute,
  type RouteReplayContext,
} from "./replay-gate.ts";
import type { ValidationDrop } from "../runtime/replay-validate.ts";
import type { RecordedAction } from "../ir/types.ts";

/** The reason the validator records against an action it never attempted. */
const CASCADE = "skipped after a preceding action failed";
const RAN_AND_FAILED = "element is not stable (waited 10000ms)";

const CTX: RouteReplayContext = {
  caseId: "todo/add_item",
  makesSomething: false,
  hasCleanup: false,
};

const click = (name: string, stepId: string): RecordedAction => ({
  action: "click",
  locator: { by: "role", value: "button", name },
  stepId,
});
const assertGone = (selector: string, stepId: string): RecordedAction => ({
  action: "assert",
  assert: "element_not_visible",
  locator: { by: "css", value: selector },
  stepId,
});
const snapshot = (stepId: string): RecordedAction => ({ action: "snapshot", stepId });
/** The same action as the recording saved it: known to fail, kept for the warning. */
const marked = (action: RecordedAction): RecordedAction => ({ ...action, replayUnstable: true });
const drop = (action: RecordedAction, reason: string, index: number): ValidationDrop => ({
  index,
  action,
  reason,
});

describe("judgeReplayedRoute", () => {
  test("a clean replay passes, and says what the route left when the case records no undo", () => {
    expect(judgeReplayedRoute([], CTX)).toEqual({ refusal: null, warnings: [] });
    expect(judgeReplayedRoute([], { ...CTX, makesSomething: true })).toEqual({
      refusal: null,
      warnings: [expect.stringContaining("records no cleanup")],
    });
  });

  test("names the action that ran and failed, and counts the wake apart from it", () => {
    const { refusal } = judgeReplayedRoute(
      [
        drop(click("Cancel", "step-04"), RAN_AND_FAILED, 0),
        drop(assertGone(".dialog-title", "step-04"), CASCADE, 1),
        drop(snapshot("step-04"), CASCADE, 2),
      ],
      CTX,
    );
    expect(refusal).toContain(`The first action that failed is step-04 click role=button[name="Cancel"]`);
    expect(refusal).toContain("2 later action(s) were not replayed at all");
    expect(refusal).toContain(RAN_AND_FAILED);
    // A skipped action is never named as a failure, nor listed as one.
    expect(refusal).not.toContain(CASCADE);
    expect(refusal).toContain("ccqa record todo/add_item");
  });

  test("a mutating action that failed refuses on its own", () => {
    const { refusal } = judgeReplayedRoute(
      [drop(click("Create new", "step-02"), RAN_AND_FAILED, 0)],
      { ...CTX, makesSomething: true, hasCleanup: true },
    );
    expect(refusal).toContain(`step-02 click role=button[name="Create new"]`);
    expect(refusal).not.toContain("later action(s)");
    expect(refusal).toContain("The recorded cleanup was not attempted");
  });

  /**
   * The failure it exists for: a modal-close tail the recording already knows
   * is flaky fails again, and the gate reads that as the route having died.
   */
  test("an action the recording already marked unstable does not refuse when it fails again", () => {
    expect(
      judgeReplayedRoute(
        [
          drop(marked(click("Cancel", "step-04")), RAN_AND_FAILED, 0),
          drop(assertGone(".dialog-title", "step-04"), CASCADE, 1),
        ],
        CTX,
      ),
    ).toEqual({
      refusal: null,
      warnings: [expect.stringContaining("none is counted against the route")],
    });
  });

  test("says the undo was not attempted when the route did not replay whole", () => {
    const discounted = [drop(marked(click("Delete", "cleanup-01")), RAN_AND_FAILED, 0)];

    const verdict = judgeReplayedRoute(discounted, {
      ...CTX,
      makesSomething: true,
      hasCleanup: true,
    });

    expect(verdict.refusal).toBeNull();
    expect(verdict).toMatchObject({
      warnings: expect.arrayContaining([
        expect.stringContaining("the recorded cleanup was not attempted"),
      ]),
    });
  });

  test("a genuine failure beside a discounted one still refuses, and names the genuine one", () => {
    const { refusal } = judgeReplayedRoute(
      [
        drop(marked(click("Cancel", "step-04")), RAN_AND_FAILED, 0),
        drop(click("Submit", "step-05"), RAN_AND_FAILED, 1),
      ],
      CTX,
    );
    expect(refusal).toContain(`The first action that failed is step-05 click role=button[name="Submit"]`);
    expect(refusal).not.toContain("Cancel");
  });
});

describe("cleanupReplayWarning", () => {
  test("names the action that ran and failed as what the check may have left behind", () => {
    expect(cleanupReplayWarning([])).toBeNull();
    expect(
      cleanupReplayWarning([
        drop(click("Delete", "step-09"), RAN_AND_FAILED, 0),
        drop(assertGone(".row", "step-09"), CASCADE, 1),
      ]),
    ).toContain(`may have left step-09 click role=button[name="Delete"] behind`);
  });

  test("claims nothing was left behind when every drop is one the recording already knew about", () => {
    expect(
      cleanupReplayWarning([drop(marked(click("Delete", "step-09")), RAN_AND_FAILED, 0)]),
    ).toContain("already marked them unstable");
  });
});
