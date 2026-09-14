import { describe, expect, it } from "vitest";
import {
  expandPathTemplate,
  recordingPathTemplate,
  resolveCaseRecordingPath,
  resolveTestPath,
  validateTestPathTemplate,
} from "./test-path.ts";

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

describe("recordingPathTemplate", () => {
  it.each([
    // The literal tail carries the extension, whether or not a placeholder
    // precedes it.
    [".ccqa/features/{feature}/test-cases/{spec}/test.spec.ts", ".ccqa/features/{feature}/test-cases/{spec}/test.spec.ccqa.ir.json"],
    ["specs/{case}.spec.ts", "specs/{case}.spec.ccqa.ir.json"],
    ["{feature}/{spec}.yaml", "{feature}/{spec}.ccqa.ir.json"],
    // No literal tail, so nothing is an extension and the case's whole id
    // stays in the name.
    ["e2e/{case}", "e2e/{case}.ccqa.ir.json"],
  ])("maps %s to %s", (template, expected) => {
    expect(recordingPathTemplate(template)).toBe(expected);
  });
});

describe("resolveCaseRecordingPath", () => {
  const target = { defaultTestPath: "e2e/{case}" };

  it("keeps a dotted case id whole, so two such cases cannot share a recording", () => {
    const alpha = resolveCaseRecordingPath(target, {}, "run.alpha");
    const beta = resolveCaseRecordingPath(target, {}, "run.beta");

    expect(alpha).toBe("e2e/run.alpha.ccqa.ir.json");
    expect(beta).toBe("e2e/run.beta.ccqa.ir.json");
  });

  it("replaces the template's extension when it has one", () => {
    expect(resolveCaseRecordingPath(target, { testPath: "specs/{case}.spec.ts" }, "todo/add.item")).toBe(
      "specs/todo/add.item.spec.ccqa.ir.json",
    );
  });
});
