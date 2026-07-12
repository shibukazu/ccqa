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

  it("accepts a single session name and normalizes it to an array", () => {
    const parsed = TestSpecSchema.parse({
      title: "x",
      mode: "live",
      session: "admin",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.session).toEqual(["admin"]);
  });

  it("accepts a list of session names", () => {
    const parsed = TestSpecSchema.parse({
      title: "x",
      mode: "live",
      session: ["admin", "viewer"],
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.session).toEqual(["admin", "viewer"]);
  });

  it("rejects a session name with a path separator", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        session: "../escape",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow();
  });

  it("rejects an empty session list", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        session: [],
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow();
  });

  it("accepts a target slug", () => {
    const parsed = TestSpecSchema.parse({
      title: "x",
      target: "playwright",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.target).toBe("playwright");
  });

  it("rejects a target with a path separator", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        target: "../escape",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow(/slug/);
  });

  it("rejects mode when target is not agent-browser", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        target: "playwright",
        mode: "live",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow(/mode.*agent-browser/);
  });

  it("rejects session when target is not agent-browser", () => {
    expect(() =>
      TestSpecSchema.parse({
        title: "x",
        target: "runn",
        session: "admin",
        steps: [{ instruction: "i", expected: "e" }],
      }),
    ).toThrow(/session.*agent-browser/);
  });

  it("accepts mode and session under an explicit agent-browser target", () => {
    const parsed = TestSpecSchema.parse({
      title: "x",
      target: "agent-browser",
      mode: "live",
      session: "admin",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.mode).toBe("live");
    expect(parsed.session).toEqual(["admin"]);
  });

  it("accepts mode and session when target is omitted", () => {
    // Effective-target resolution (config defaultTarget) happens after
    // parsing, so the schema can't reject these here.
    const parsed = TestSpecSchema.parse({
      title: "x",
      mode: "live",
      session: "admin",
      steps: [{ instruction: "i", expected: "e" }],
    });
    expect(parsed.target).toBeUndefined();
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
