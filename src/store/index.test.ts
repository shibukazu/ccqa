import { describe, test, expect } from "bun:test";
import { parseSpecPath, getVeriqDir, getFeatureDir, getSpecDir, routeToMarkdown } from "./index.ts";
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
  test("getVeriqDir uses process.cwd by default", () => {
    expect(getVeriqDir()).toBe(`${process.cwd()}/.veriq`);
  });

  test("getVeriqDir uses provided cwd", () => {
    expect(getVeriqDir("/custom")).toBe("/custom/.veriq");
  });

  test("getFeatureDir returns correct path", () => {
    expect(getFeatureDir("my-feature", "/custom")).toBe("/custom/.veriq/features/my-feature");
  });

  test("getSpecDir returns correct path", () => {
    expect(getSpecDir("my-feature", "my-spec", "/custom")).toBe(
      "/custom/.veriq/features/my-feature/test-cases/my-spec",
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
