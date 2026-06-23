import { describe, expect, it } from "vitest";
import { parseBlockSpec, parseTestSpec } from "./parser.ts";

describe("parseTestSpec", () => {
  it("parses a minimal YAML spec", () => {
    const spec = parseTestSpec(`title: demo
steps:
  - instruction: open /
    expected: home shown
`);
    expect(spec.title).toBe("demo");
    expect(spec.steps).toHaveLength(1);
  });

  it("parses include steps with params", () => {
    const spec = parseTestSpec(`title: demo
steps:
  - include: login
    params:
      email: a@b
      password: secret
  - instruction: click home
    expected: redirected
`);
    expect(spec.steps).toHaveLength(2);
    const include = spec.steps[0]!;
    expect("include" in include && include.include).toBe("login");
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      parseTestSpec(`title: demo
unexpected: value
steps:
  - instruction: i
    expected: e
`),
    ).toThrow(/unexpected/);
  });

  it("yields a multi-line error listing every issue", () => {
    let err: Error | null = null;
    try {
      parseTestSpec(`title: x
steps: []
`);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Invalid spec\.yaml/);
  });
});

describe("parseBlockSpec", () => {
  it("parses a block with params", () => {
    const block = parseBlockSpec(`title: Login
params:
  - name: email
  - name: password
    secret: true
steps:
  - instruction: open login
    expected: form
`);
    expect(block.params).toHaveLength(2);
  });

  it("rejects nested includes with a targeted message", () => {
    expect(() =>
      parseBlockSpec(`title: outer
steps:
  - include: inner
`),
    ).toThrow(/Nested blocks/);
  });
});
