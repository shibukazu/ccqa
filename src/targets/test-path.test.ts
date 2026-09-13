import { describe, expect, it } from "vitest";
import { expandPathTemplate, resolveTestPath, validateTestPathTemplate } from "./test-path.ts";

describe("expandPathTemplate", () => {
  it("fills the placeholders it is given", () => {
    expect(
      expandPathTemplate("e2e/specs/{feature}/{spec}.spec.ts", {
        feature: "tasks",
        spec: "create-and-complete",
      }),
    ).toBe("e2e/specs/tasks/create-and-complete.spec.ts");
  });

  it("rejects a placeholder the substitution table has no value for", () => {
    expect(() => expandPathTemplate("e2e/{screen}/{spec}.ts", { spec: "x" })).toThrow(
      /unknown placeholder \{screen\}.*available: \{spec\}/,
    );
  });
});

describe("validateTestPathTemplate", () => {
  it("accepts a project-relative per-spec template", () => {
    expect(validateTestPathTemplate("e2e/specs/{feature}/{spec}.spec.ts")).toBeNull();
  });

  it.each([
    ["/abs/{spec}.ts", /relative to the project root/],
    ["../outside/{spec}.ts", /must not contain/],
    ["e2e/specs/{feature}.spec.ts", /\{spec\}/],
    // Caught at config load, so a typo is one error rather than a different
    // failure in each command that expands the template later.
    ["e2e/{featureName}/{spec}.spec.ts", /no \{featureName\} to fill in/],
  ])("rejects %s", (template, message) => {
    expect(validateTestPathTemplate(template)).toMatch(message);
  });
});

describe("resolveTestPath", () => {
  const target = { defaultTestPath: ".ccqa/features/{feature}/test-cases/{spec}/test.spec.ts" };
  const ref = { featureName: "tasks", specName: "create" };

  it("prefers the project's configured template", () => {
    expect(resolveTestPath(target, { testPath: "e2e/{feature}/{spec}.spec.ts" }, ref)).toBe(
      "e2e/tasks/create.spec.ts",
    );
  });

  it("falls back to the target's own default", () => {
    expect(resolveTestPath(target, {}, ref)).toBe(
      ".ccqa/features/tasks/test-cases/create/test.spec.ts",
    );
  });
});
