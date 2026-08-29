import { describe, expect, it } from "vitest";
import { placeJudgements } from "./index.ts";
import type { ExpandedStep } from "../../spec/expand.ts";
import type { RecordedAction } from "../../types.ts";

const act = (stepId?: string): RecordedAction =>
  ({ action: "click", locator: { by: "css", value: "#x" }, ...(stepId ? { stepId } : {}) }) as RecordedAction;

const action = (id: string): ExpandedStep => ({ id, source: "spec", instruction: "i", expected: "e" });
const judge = (id: string): ExpandedStep => ({ id, source: "spec", judgeByLlm: "c" });

describe("placeJudgements", () => {
  it("places a claim after the last action of the step before it", () => {
    const out = placeJudgements(
      [action("step-01"), judge("step-02"), action("step-03")],
      [act("step-01"), act("step-03")],
      "f/s",
    );
    expect(out.judgements).toEqual([{ step: judge("step-02"), afterActionIndex: 0 }]);
    expect(out.warnings).toEqual([]);
  });

  // The claim would otherwise be asserted against whatever page the run had
  // not reached yet — and a negative claim would pass there untested.
  it("puts a claim last and says so when nothing attributes actions to the steps before it", () => {
    const out = placeJudgements([action("step-01"), judge("step-02")], [act(), act()], "f/s");
    expect(out.judgements).toEqual([{ step: judge("step-02"), afterActionIndex: 1 }]);
    expect(out.warnings[0]).toMatch(/asserted at the end of the test/);
  });

  it("refuses a claim as the first step — nothing has happened yet", () => {
    expect(() => placeJudgements([judge("step-01"), action("step-02")], [act("step-02")], "f/s")).toThrow(
      /as the first step/,
    );
  });
});
