import { describe, expect, it } from "vitest";
import {
  ActionStepSchema,
  BlockSpecSchema,
  IncludeStepSchema,
  TestSpecSchema,
  isIncludeStep,
  isParamRequired,
} from "./yaml-schema.ts";

describe("TestSpecSchema", () => {
  it("accepts a spec with action and include steps", () => {
    const parsed = TestSpecSchema.parse({
      title: "demo",
      steps: [
        { include: "login", params: { email: "a@b" } },
        { instruction: "open /", expected: "home shown" },
      ],
    });
    expect(parsed.steps).toHaveLength(2);
  });

  it("rejects missing title", () => {
    expect(() =>
      TestSpecSchema.parse({
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        extra: "value",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow(/extra/);
  });

  it("requires at least one step", () => {
    expect(() => TestSpecSchema.parse({ title: "x", steps: [] })).toThrow();
  });

  it("rejects unknown keys inside action step", () => {
    expect(() =>
      ActionStepSchema.parse({
        instruction: "i",
        expected: "e",
        instr: "typo",
      }),
    ).toThrow();
  });

  it("requires include or all action fields — partial step is rejected", () => {
    // Missing expected — not a valid action step.
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        steps: [{ instruction: "only instruction" }],
      }),
    ).toThrow();
  });

  it("accepts an optional statePath pointing at a saved auth-state file", () => {
    const parsed = TestSpecSchema.parse({
      title: "x",
      mode: "live",
      statePath: ".ccqa/sessions/slack-stg.json",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.statePath).toBe(".ccqa/sessions/slack-stg.json");
  });

  it("rejects empty statePath", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        statePath: "",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow();
  });
});

describe("BlockSpecSchema", () => {
  it("accepts a block with params and action steps", () => {
    const block = BlockSpecSchema.parse({
      title: "login",
      params: [
        { name: "email" },
        { name: "password", required: true, secret: true },
      ],
      steps: [{ instruction: "go", expected: "form" }],
    });
    expect(block.params).toHaveLength(2);
  });

  it("rejects nested include inside a block", () => {
    expect(() =>
      BlockSpecSchema.parse({
        title: "x",
        steps: [{ include: "other" }],
      }),
    ).toThrow();
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      BlockSpecSchema.parse({
        title: "x",
        extra: "value",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow();
  });
});

describe("isIncludeStep", () => {
  it("discriminates by include key", () => {
    const inc = IncludeStepSchema.parse({ include: "login" });
    const act = ActionStepSchema.parse({ instruction: "i", expected: "e" });
    expect(isIncludeStep(inc)).toBe(true);
    expect(isIncludeStep(act)).toBe(false);
  });
});

describe("isParamRequired", () => {
  it("defaults to required when unset", () => {
    expect(isParamRequired({ name: "x" })).toBe(true);
  });
  it("respects explicit required: false", () => {
    expect(isParamRequired({ name: "x", required: false })).toBe(false);
  });
});
