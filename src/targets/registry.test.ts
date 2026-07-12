import { describe, expect, it } from "vitest";
import { resolveTarget, resolveTargetFrom, resolveTargetOverride } from "./registry.ts";
import { agentBrowserTarget } from "./agent-browser/index.ts";
import { ProjectConfigSchema } from "../config/project-config.ts";
import { TestSpecSchema, type TestSpec } from "../spec/yaml-schema.ts";
import type { GenerateResult, TargetPlugin } from "./types.ts";

function makeSpec(extra: Record<string, unknown> = {}): TestSpec {
  return TestSpecSchema.parse({
    title: "sample",
    steps: [{ instruction: "open the page", expected: "the form is shown" }],
    ...extra,
  });
}

function fakePlugin(id: string): TargetPlugin {
  return {
    id,
    input: "spec",
    generate: (): Promise<GenerateResult> => {
      throw new Error("not under test");
    },
  };
}

/** agent-browser plus one fake target, so precedence and validation are observable. */
function registryWith(...plugins: TargetPlugin[]): ReadonlyMap<string, TargetPlugin> {
  return new Map([agentBrowserTarget, ...plugins].map((p) => [p.id, p]));
}

describe("resolveTarget", () => {
  it("defaults to agent-browser when neither spec nor config names a target", () => {
    const resolved = resolveTarget(makeSpec(), ProjectConfigSchema.parse({}));
    expect(resolved).toBe(agentBrowserTarget);
  });

  it("prefers the spec's target over the config defaultTarget", () => {
    const fake = fakePlugin("fake-target");
    const config = ProjectConfigSchema.parse({ defaultTarget: "fake-target" });
    const resolved = resolveTargetFrom(makeSpec({ target: "agent-browser" }), config, registryWith(fake));
    expect(resolved).toBe(agentBrowserTarget);
  });

  it("falls back to the config defaultTarget when the spec has none", () => {
    const fake = fakePlugin("fake-target");
    const config = ProjectConfigSchema.parse({ defaultTarget: "fake-target" });
    const resolved = resolveTargetFrom(makeSpec(), config, registryWith(fake));
    expect(resolved).toBe(fake);
  });

  it("rejects an unknown spec target, listing the registered ids", () => {
    const spec = makeSpec({ target: "no-such-target" });
    expect(() => resolveTarget(spec, ProjectConfigSchema.parse({}))).toThrow(
      /unknown target "no-such-target" \(from spec\.yaml `target:`\).*agent-browser/,
    );
  });

  it("rejects an unknown config defaultTarget, attributing it to the config", () => {
    const config = ProjectConfigSchema.parse({ defaultTarget: "no-such-target" });
    expect(() => resolveTarget(makeSpec(), config)).toThrow(
      /unknown target "no-such-target" \(from `defaultTarget` in \.ccqa\/config\.yaml\)/,
    );
  });

  // The spec schema can only reject `mode:`/`session:` when the spec itself
  // names a non-agent-browser target; with `target:` omitted they pass parsing
  // and this post-resolution check is the last line of defence.
  it("rejects `mode:` when the config default resolves to a non-agent-browser target", () => {
    const fake = fakePlugin("fake-target");
    const config = ProjectConfigSchema.parse({ defaultTarget: "fake-target" });
    expect(() => resolveTargetFrom(makeSpec({ mode: "live" }), config, registryWith(fake))).toThrow(
      /`mode` only applies to the agent-browser target.*`defaultTarget`/,
    );
  });

  it("rejects `session:` when the config default resolves to a non-agent-browser target", () => {
    const fake = fakePlugin("fake-target");
    const config = ProjectConfigSchema.parse({ defaultTarget: "fake-target" });
    expect(() =>
      resolveTargetFrom(makeSpec({ session: "signed-in" }), config, registryWith(fake)),
    ).toThrow(/`session` only applies to the agent-browser target/);
  });

  it("keeps `mode:`/`session:` valid when the spec resolves to agent-browser", () => {
    const config = ProjectConfigSchema.parse({});
    const spec = makeSpec({ mode: "live", session: "signed-in" });
    expect(resolveTarget(spec, config)).toBe(agentBrowserTarget);
  });
});

describe("resolveTargetOverride", () => {
  it("wins over the spec's own target", () => {
    const spec = makeSpec({ target: "agent-browser" });
    expect(resolveTargetOverride(spec, "playwright").id).toBe("playwright");
  });

  it("rejects a non-agent-browser override for mode/session specs", () => {
    expect(() => resolveTargetOverride(makeSpec({ mode: "live" }), "playwright")).toThrow(/mode/);
    expect(() => resolveTargetOverride(makeSpec({ session: "s" }), "runn")).toThrow(/session/);
  });

  it("rejects an unknown target id", () => {
    expect(() => resolveTargetOverride(makeSpec(), "nope")).toThrow(/--target/);
  });
});
