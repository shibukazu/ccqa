import { describe, test, expect } from "vitest";
import { parseSpecPath, getCcqaDir, getFeatureDir, getSpecDir, routeToMarkdown } from "./index.ts";
import type { Route } from "../types.ts";

describe("parseSpecPath", () => {
  test("parses valid feature/spec path", () => {
    expect(parseSpecPath("feat/spec")).toEqual({ featureName: "feat", specName: "spec" });
    expect(parseSpecPath("tasks/create-and-complete")).toEqual({
      featureName: "tasks",
      specName: "create-and-complete",
    });
  });

  test("throws on single segment", () => {
    expect(() => parseSpecPath("feat")).toThrow();
  });

  test("throws on three segments", () => {
    expect(() => parseSpecPath("a/b/c")).toThrow();
  });

  test("throws on empty string", () => {
    expect(() => parseSpecPath("")).toThrow();
  });

  test("throws on empty feature name", () => {
    expect(() => parseSpecPath("/spec")).toThrow();
  });

  test("throws on empty spec name", () => {
    expect(() => parseSpecPath("feat/")).toThrow();
  });
});

describe("path helpers", () => {
  test("getCcqaDir uses process.cwd by default", () => {
    expect(getCcqaDir()).toBe(`${process.cwd()}/.ccqa`);
  });

  test("getCcqaDir uses provided cwd", () => {
    expect(getCcqaDir("/custom")).toBe("/custom/.ccqa");
  });

  test("getFeatureDir returns correct path", () => {
    expect(getFeatureDir("my-feature", "/custom")).toBe("/custom/.ccqa/features/my-feature");
  });

  test("getSpecDir returns correct path", () => {
    expect(getSpecDir("my-feature", "my-spec", "/custom")).toBe(
      "/custom/.ccqa/features/my-feature/test-cases/my-spec",
    );
  });


});

describe("routeToMarkdown", () => {
  const baseRoute: Route = {
    specName: "create-and-complete",
    timestamp: "2026-03-28T00:00:00.000Z",
    status: "passed",
    steps: [],
  };

  test("generates correct frontmatter", () => {
    const md = routeToMarkdown(baseRoute);
    expect(md).toContain('specName: "create-and-complete"');
    expect(md).toContain('timestamp: "2026-03-28T00:00:00.000Z"');
    expect(md).toContain('status: "passed"');
  });

  test("generates step section", () => {
    const route: Route = {
      ...baseRoute,
      steps: [
        { title: "Login", action: "filled form", observation: "redirected", status: "PASSED" },
      ],
    };
    const md = routeToMarkdown(route);
    expect(md).toContain("## Login");
    expect(md).toContain("- **action**: filled form");
    expect(md).toContain("- **observation**: redirected");
    expect(md).toContain("- **status**: PASSED");
  });

  test("includes reason when present", () => {
    const route: Route = {
      ...baseRoute,
      steps: [
        { title: "Fail", action: "clicked", observation: "nothing", status: "FAILED", reason: "button disabled" },
      ],
    };
    const md = routeToMarkdown(route);
    expect(md).toContain("- **reason**: button disabled");
  });

  test("omits reason line when absent", () => {
    const route: Route = {
      ...baseRoute,
      steps: [
        { title: "Pass", action: "clicked", observation: "ok", status: "PASSED" },
      ],
    };
    const md = routeToMarkdown(route);
    expect(md).not.toContain("- **reason**");
  });
});
