import { describe, test, expect } from "vitest";
import { parseBlockPath, parseSpecPath, getCcqaDir, getFeatureDir, getSpecDir, loadPromptBundleFromHub, routeToMarkdown } from "./index.ts";
import type { Route } from "../types.ts";
import type { HubClient } from "../hub-client/index.ts";

/** Minimal fake — only `getPrompt` is exercised by these tests. */
function fakeHubClient(getPrompt: HubClient["getPrompt"]): HubClient {
  return { getPrompt } as unknown as HubClient;
}

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

  test("accepts the on-disk 4-segment form features/<f>/test-cases/<s>", () => {
    expect(parseSpecPath("features/tasks/test-cases/create-and-complete")).toEqual({
      featureName: "tasks",
      specName: "create-and-complete",
    });
  });

  test("accepts the .ccqa-prefixed 5-segment form", () => {
    expect(parseSpecPath(".ccqa/features/tasks/test-cases/create-and-complete")).toEqual({
      featureName: "tasks",
      specName: "create-and-complete",
    });
  });

  test("tolerates trailing slashes", () => {
    expect(parseSpecPath("features/tasks/test-cases/create-and-complete/")).toEqual({
      featureName: "tasks",
      specName: "create-and-complete",
    });
  });

  test("rejects 4-segment paths with the wrong middle structure", () => {
    expect(() => parseSpecPath("features/tasks/oops/spec")).toThrow();
    expect(() => parseSpecPath("a/b/c/d")).toThrow();
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

describe("parseBlockPath", () => {
  test("recognises spec.yaml under a block dir", () => {
    expect(parseBlockPath(".ccqa/blocks/login/spec.yaml")).toBe("login");
    expect(parseBlockPath("apps/web/.ccqa/blocks/login/spec.yaml")).toBe("login");
  });

  test("does not match block actions.json or route.md (v0.4 inlines blocks per spec)", () => {
    expect(parseBlockPath(".ccqa/blocks/login/actions.json")).toBeNull();
    expect(parseBlockPath(".ccqa/blocks/login/route.md")).toBeNull();
  });

  test("does not match block test.spec.ts (no longer authoritative)", () => {
    expect(parseBlockPath(".ccqa/blocks/login/test.spec.ts")).toBeNull();
  });

  test("returns null for non-block paths", () => {
    expect(parseBlockPath(".ccqa/features/x/test-cases/y/spec.yaml")).toBeNull();
    expect(parseBlockPath("src/cli/run.ts")).toBeNull();
    expect(parseBlockPath(".ccqa/blocks/login/extra.txt")).toBeNull();
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

describe("loadPromptBundleFromHub", () => {
  test("returns null when there's no hub client", async () => {
    expect(await loadPromptBundleFromHub(null, "live")).toBeNull();
  });

  test("returns null when the hub has neither prompt stored", async () => {
    const hub = fakeHubClient(async () => null);
    expect(await loadPromptBundleFromHub({ hub, project: "demo" }, "record")).toBeNull();
  });

  test("assembles a combined bundle with hub prompt names as `loaded` labels", async () => {
    const hub = fakeHubClient(async (_project, name) =>
      name === "live.user" ? "Stable rule." : name === "live.agent" ? "Learned hint." : null,
    );
    const out = await loadPromptBundleFromHub({ hub, project: "demo" }, "live");
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual(["live.user", "live.agent"]);
    expect(out!.text).toContain("Stable rule.");
    expect(out!.text).toContain("Learned hint.");
  });

  test("returns null when getPrompt throws", async () => {
    const hub = fakeHubClient(async () => {
      throw new Error("network error");
    });
    expect(await loadPromptBundleFromHub({ hub, project: "demo" }, "record")).toBeNull();
  });
});
