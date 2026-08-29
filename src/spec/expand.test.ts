import { describe, expect, it } from "vitest";
import { collectIncludedBlockNames, expandActionSteps, expandSpec } from "./expand.ts";
import { BlockSpecSchema, TestSpecSchema } from "./yaml-schema.ts";

const loginBlock = BlockSpecSchema.parse({
  title: "Login",
  params: [
    { name: "loginUrl" },
    { name: "email" },
    { name: "password", secret: true },
  ],
  steps: [
    { instruction: "open ${loginUrl}", expected: "form shown" },
    { instruction: "fill email=${email} password=${password}", expected: "logged in" },
  ],
});

describe("expandSpec", () => {
  it("inlines an included block's steps with the block name as source and substitutes params", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [
        {
          include: "login",
          params: { loginUrl: "https://idp/", email: "a@b", password: "${SECRET}" },
        },
        { instruction: "click home", expected: "home shown" },
      ],
    });
    const expanded = expandSpec(spec, { blocks: new Map([["login", loginBlock]]) });
    expect(expanded.map((s) => s.id)).toEqual(["step-01", "step-02", "step-03"]);
    expect(expanded[0]).toMatchObject({
      source: "login",
      instruction: "open https://idp/",
      expected: "form shown",
    });
    expect(expanded[1]).toMatchObject({
      source: "login",
      instruction: "fill email=a@b password=${SECRET}",
      expected: "logged in",
    });
    expect(expanded[2]).toMatchObject({ source: "spec", instruction: "click home" });
  });

  it("throws when an include references a missing block", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ include: "missing" }],
    });
    expect(() => expandSpec(spec, { blocks: new Map() })).toThrow(/Unknown block/);
  });

  it("throws on undeclared params", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ include: "login", params: { typo: "x", loginUrl: "u", email: "e", password: "p" } }],
    });
    expect(() =>
      expandSpec(spec, { blocks: new Map([["login", loginBlock]]) }),
    ).toThrow(/unknown param "typo"/);
  });

  it("throws when a required param is missing", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ include: "login", params: { loginUrl: "u", email: "e" } }],
    });
    expect(() =>
      expandSpec(spec, { blocks: new Map([["login", loginBlock]]) }),
    ).toThrow(/missing required param "password"/);
  });

  it("permits omitted optional params on a block call and leaves unresolved refs intact", () => {
    const block = BlockSpecSchema.parse({
      title: "x",
      params: [{ name: "extra", required: false }],
      steps: [{ instruction: "use ${extra}", expected: "e" }],
    });
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ include: "blk" }],
    });
    const expanded = expandSpec(spec, { blocks: new Map([["blk", block]]) });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      id: "step-01",
      source: "blk",
      instruction: "use ${extra}",
    });
  });
});

describe("collectIncludedBlockNames", () => {
  it("returns unique block names referenced in include steps", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [
        { include: "login" },
        { instruction: "i", expected: "e" },
        { include: "login" },
        { include: "logout" },
      ],
    });
    expect(collectIncludedBlockNames(spec).sort()).toEqual(["login", "logout"]);
  });
});

describe("expandSpec — judgeByLlm", () => {
  const judgeBlock = BlockSpecSchema.parse({
    title: "ask",
    params: [{ name: "topic" }],
    steps: [{ judgeByLlm: "the answer covers ${topic}", from: ".answer" }],
  });

  it("substitutes block params into a claim", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      target: "playwright",
      steps: [{ include: "ask", params: { topic: "refunds" } }],
    });
    const expanded = expandSpec(spec, { blocks: new Map([["ask", judgeBlock]]) });
    expect(expanded[0]).toMatchObject({
      id: "step-01",
      source: "ask",
      judgeByLlm: "the answer covers refunds",
      from: ".answer",
    });
  });

  it("refuses a claim on a target that cannot judge it, naming the block it came from", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ include: "ask", params: { topic: "refunds" } }],
    });
    expect(() =>
      expandActionSteps(spec, { blocks: new Map([["ask", judgeBlock]]) }, "f/s", {
        id: "agent-browser",
        reason: "it decides each step itself",
      }),
    ).toThrow(/step step-01 \(from block `ask`\).*"agent-browser" target cannot honour it/);
  });

  it("passes a spec without claims through unchanged", () => {
    const spec = TestSpecSchema.parse({
      title: "demo",
      steps: [{ instruction: "i", expected: "e" }],
    });
    const target = { id: "runn", reason: "there is no page to read a claim off" };
    expect(expandActionSteps(spec, { blocks: new Map() }, "f/s", target)).toHaveLength(1);
  });
});
