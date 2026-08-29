import { describe, expect, it } from "vitest";
import { parseVerdict } from "./judge.ts";

describe("parseVerdict", () => {
  it("reads the verdict the model was asked for", () => {
    expect(parseVerdict('{"ok": true, "reason": "the answer lists the steps"}')).toEqual({
      ok: true,
      reason: "the answer lists the steps",
    });
  });

  it("takes the object out of an answer the model wrapped in prose or a fence", () => {
    const wrapped = 'Sure!\n```json\n{"ok": false, "reason": "it says it does not know"}\n```';
    expect(parseVerdict(wrapped)).toEqual({ ok: false, reason: "it says it does not know" });
  });

  it("skips an object that carries no verdict", () => {
    const answer = '{"note": "thinking"}\n{"ok": false, "reason": "the reply is a refusal"}';
    expect(parseVerdict(answer)).toEqual({ ok: false, reason: "the reply is a refusal" });
  });

  // Each of these is a decision that was not made. Reading one as a pass would
  // let a claim go unjudged while the test still went green.
  it("refuses an answer it cannot read a verdict out of", () => {
    for (const answer of ["looks fine to me", "{not json}", '{"reason": "no ok"}', '{"ok": "yes"}']) {
      expect(() => parseVerdict(answer)).toThrow(/no verdict/);
    }
  });

  it("keeps a verdict whose reason the model left out", () => {
    expect(parseVerdict('{"ok": true}')).toEqual({ ok: true, reason: "" });
  });
});
