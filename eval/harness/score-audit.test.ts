import { describe, expect, it } from "vitest";
import {
  buildConfusionMatrix,
  scoreAuditCase,
  type AuditOutput,
} from "./score-audit.ts";

const row = (
  spec: string,
  drift: AuditOutput["specs"][number]["drift"],
  ok = true,
): AuditOutput["specs"][number] => {
  const [feature, name] = spec.split("/");
  return { feature: feature!, spec: name!, ok, drift };
};

describe("scoreAuditCase", () => {
  it("scores unlisted specs against CLEAN, so a false finding counts", () => {
    const outcomes = scoreAuditCase(
      { "a/mutated": { label: "TEST_DRIFT" } },
      {
        specs: [
          row("a/mutated", { label: "TEST_DRIFT", surface: "generated" }),
          row("a/bystander", { label: "SPEC_CHANGE" }),
          row("a/quiet", null),
        ],
      },
    );
    expect(outcomes.map((o) => [o.spec, o.expected, o.predicted, o.labelMatch])).toEqual([
      ["a/mutated", "TEST_DRIFT", "TEST_DRIFT", true],
      ["a/bystander", "CLEAN", "SPEC_CHANGE", false],
      ["a/quiet", "CLEAN", "CLEAN", true],
    ]);
  });

  it("buckets a failed check as ERROR, never as a verdict", () => {
    const outcomes = scoreAuditCase({}, { specs: [row("a/broken", null, false)] });
    expect(outcomes[0]!.predicted).toBe("ERROR");
    expect(outcomes[0]!.labelMatch).toBe(false);
  });

  it("throws when an expected spec never appears in the sweep", () => {
    expect(() =>
      scoreAuditCase({ "a/gone": { label: "TEST_DRIFT" } }, { specs: [row("a/other", null)] }),
    ).toThrow(/a\/gone/);
  });

  it("scores declared sub-answers only when the label matched", () => {
    const expectations = {
      "a/one": { label: "SPEC_CHANGE" as const, surface: "generated" as const, specChangeKind: "FEATURE_REMOVED" as const },
      "a/two": { label: "SPEC_CHANGE" as const, surface: "generated" as const },
    };
    const outcomes = scoreAuditCase(expectations, {
      specs: [
        row("a/one", { label: "SPEC_CHANGE", surface: "generated", specChangeKind: "BEHAVIOUR_CHANGED" }),
        row("a/two", { label: "TEST_DRIFT", surface: "generated" }),
      ],
    });
    expect(outcomes[0]!.subAnswers).toEqual([
      { field: "surface", expected: "generated", got: "generated", match: true },
      { field: "specChangeKind", expected: "FEATURE_REMOVED", got: "BEHAVIOUR_CHANGED", match: false },
    ]);
    // Wrong label: its sub-fields answer a question that was not asked.
    expect(outcomes[1]!.subAnswers).toEqual([]);
  });
});

describe("buildConfusionMatrix", () => {
  it("tallies cells, accuracy and sub-answers", () => {
    const outcomes = scoreAuditCase(
      { "a/mutated": { label: "TEST_DRIFT", surface: "generated" } },
      {
        specs: [
          row("a/mutated", { label: "TEST_DRIFT", surface: "generated" }),
          row("a/bystander", { label: "UNKNOWN" }),
          row("a/quiet", null),
        ],
      },
    );
    const confusion = buildConfusionMatrix(outcomes);
    expect(confusion.matrix.TEST_DRIFT.TEST_DRIFT).toBe(1);
    expect(confusion.matrix.CLEAN.UNKNOWN).toBe(1);
    expect(confusion.matrix.CLEAN.CLEAN).toBe(1);
    expect(confusion.total).toBe(3);
    expect(confusion.correct).toBe(2);
    expect(confusion.accuracy).toBeCloseTo(2 / 3);
    expect(confusion.cleanRecall).toEqual({ correct: 1, total: 2 });
    expect(confusion.driftRecall).toEqual({ correct: 1, total: 1 });
    expect(confusion.subAnswers).toEqual({ total: 1, correct: 1 });
  });
});
