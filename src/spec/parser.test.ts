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

  it("points a spec with `relatedPaths` at `ccqa select-specs` instead of a generic unknown-key error", () => {
    expect(() =>
      parseTestSpec(`title: demo
relatedPaths:
  - src/foo.ts
steps:
  - instruction: i
    expected: e
`),
    ).toThrow(/relatedPaths.*no longer part of the spec schema.*ccqa select-specs/s);
  });

  it("keeps the generic unknown-key message for `description` at the spec root", () => {
    let err: Error | null = null;
    try {
      parseTestSpec(`title: demo
description: a note
steps:
  - instruction: i
    expected: e
`);
    } catch (e) {
      err = e as Error;
    }
    expect(err!.message).toMatch(/Unknown keys: description/);
    expect(err!.message).not.toMatch(/no longer part of the spec schema/);
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

  // The advice is only right for an `include`. A block step is a union, so a
  // typo fails the same way — telling its author to flatten a block would
  // send them looking for one that is not there.
  it("does not blame nesting for a step that is merely misspelt", () => {
    expect(() =>
      parseBlockSpec(`title: B
steps:
  - instructon: go
    expected: there
`),
    ).toThrow(/Invalid input/);
  });

  it("tells a param carrying `dummy` or `description` that nothing reads it", () => {
    for (const field of ["dummy", "description"]) {
      expect(() =>
        parseBlockSpec(`title: Login
params:
  - name: email
    ${field}: something
steps:
  - instruction: i
    expected: e
`),
      ).toThrow(new RegExp(`${field}.*no longer part of the spec schema.*Delete the line`, "s"));
    }
  });

  it("points a block with `relatedPaths` at the same migration note as a spec", () => {
    expect(() =>
      parseBlockSpec(`title: Login
relatedPaths:
  - src/foo.ts
steps:
  - instruction: i
    expected: e
`),
    ).toThrow(/relatedPaths.*no longer part of the spec schema.*ccqa select-specs/s);
  });
});

describe("union step errors", () => {
  it("reports the branch whose key the author used, not the one that rejects it", () => {
    // Told "Unknown keys: judgeByLlm" instead, an author converting a step is
    // told the key they just wrote does not exist.
    expect(() => parseTestSpec("title: s\nsteps:\n  - judgeByLlm: c\n    instruction: go\n")).toThrow(
      /Unknown keys: instruction/,
    );
    expect(() => parseTestSpec("title: s\nsteps:\n  - instruction: i\n    expcted: e\n")).toThrow(
      /Unknown keys: expcted/,
    );
  });

  it("scopes a removed-field message to the root it was removed from", () => {
    expect(() =>
      parseTestSpec("title: s\nsteps:\n  - instruction: i\n    expected: e\n    relatedPaths: [a]\n"),
    ).toThrow(/Unknown keys: relatedPaths/);
    expect(() =>
      parseTestSpec("title: s\nrelatedPaths: [a]\nsteps:\n  - instruction: i\n    expected: e\n"),
    ).toThrow(/no longer part of the spec schema/);
  });
});
