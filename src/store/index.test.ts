import { describe, test, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlockPath, parseSpecPath, getCcqaDir, getFeatureDir, getSpecDir, loadLivePromptBundle, loadRecordPromptBundle, routeToMarkdown } from "./index.ts";
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

describe("loadRecordPromptBundle", () => {
  async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-record-prompt-bundle-"));
    await mkdir(join(dir, ".ccqa", "prompts"), { recursive: true });
    return dir;
  }

  test("returns null when both files are missing", async () => {
    const dir = await makeWorkspace();
    expect(await loadRecordPromptBundle(dir)).toBeNull();
  });

  test("returns a user-only bundle when only record.user.md exists", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/record.user.md"),
      "Use only [data-testid='*'] selectors.\n",
      "utf-8",
    );
    const out = await loadRecordPromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([".ccqa/prompts/record.user.md"]);
    expect(out!.text).toContain("Project guidance (human-maintained)");
    expect(out!.text).toContain("Use only [data-testid='*'] selectors.");
    expect(out!.text).not.toContain("Agent learnings");
  });

  test("returns an agent-only bundle when only record.agent.md exists", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/record.agent.md"),
      "Auto-learned: the login form uses [name=identifier].\n",
      "utf-8",
    );
    const out = await loadRecordPromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([".ccqa/prompts/record.agent.md"]);
    expect(out!.text).toContain("Agent learnings (auto-updated by ccqa --update-agent-prompt)");
    expect(out!.text).toContain("Auto-learned");
    expect(out!.text).not.toContain("Project guidance");
  });

  test("returns a combined bundle when both files exist", async () => {
    const dir = await makeWorkspace();
    await writeFile(join(dir, ".ccqa/prompts/record.user.md"), "Stable rule.\n", "utf-8");
    await writeFile(join(dir, ".ccqa/prompts/record.agent.md"), "Learned hint.\n", "utf-8");
    const out = await loadRecordPromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([
      ".ccqa/prompts/record.user.md",
      ".ccqa/prompts/record.agent.md",
    ]);
    expect(out!.text).toContain("Stable rule.");
    expect(out!.text).toContain("Learned hint.");
    // user section appears before agent section
    expect(out!.text.indexOf("Stable rule.")).toBeLessThan(out!.text.indexOf("Learned hint."));
  });

  test("truncates the concatenated bundle at 32 KiB", async () => {
    const dir = await makeWorkspace();
    await writeFile(join(dir, ".ccqa/prompts/record.user.md"), "x".repeat(20_000), "utf-8");
    await writeFile(join(dir, ".ccqa/prompts/record.agent.md"), "y".repeat(20_000), "utf-8");
    const out = await loadRecordPromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.text).toMatch(/prompt bundle truncated at 32768 bytes/);
  });

  test("does NOT read the old .ccqa/prompts/trace.user.md path", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/trace.user.md"),
      "legacy content",
      "utf-8",
    );
    expect(await loadRecordPromptBundle(dir)).toBeNull();
  });
});

describe("loadLivePromptBundle", () => {
  async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-live-prompt-bundle-"));
    await mkdir(join(dir, ".ccqa", "prompts"), { recursive: true });
    return dir;
  }

  test("returns null when both files are missing", async () => {
    const dir = await makeWorkspace();
    expect(await loadLivePromptBundle(dir)).toBeNull();
  });

  test("returns a user-only bundle when only live.user.md exists", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/live.user.md"),
      "Project guidance line.\n",
      "utf-8",
    );
    const out = await loadLivePromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([".ccqa/prompts/live.user.md"]);
    expect(out!.text).toContain("Project guidance line.");
  });

  test("returns an agent-only bundle when only live.agent.md exists", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/live.agent.md"),
      "Auto-learned hint.\n",
      "utf-8",
    );
    const out = await loadLivePromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([".ccqa/prompts/live.agent.md"]);
    expect(out!.text).toContain("Auto-learned hint.");
  });

  test("returns a combined bundle when both files exist", async () => {
    const dir = await makeWorkspace();
    await writeFile(join(dir, ".ccqa/prompts/live.user.md"), "Stable rule.", "utf-8");
    await writeFile(join(dir, ".ccqa/prompts/live.agent.md"), "Learned hint.", "utf-8");
    const out = await loadLivePromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual([
      ".ccqa/prompts/live.user.md",
      ".ccqa/prompts/live.agent.md",
    ]);
    expect(out!.text.indexOf("Stable rule.")).toBeLessThan(out!.text.indexOf("Learned hint."));
  });

  test("truncates the concatenated bundle at 32 KiB", async () => {
    const dir = await makeWorkspace();
    await writeFile(join(dir, ".ccqa/prompts/live.user.md"), "u".repeat(20_000), "utf-8");
    await writeFile(join(dir, ".ccqa/prompts/live.agent.md"), "a".repeat(20_000), "utf-8");
    const out = await loadLivePromptBundle(dir);
    expect(out).not.toBeNull();
    expect(out!.text).toMatch(/prompt bundle truncated at 32768 bytes/);
  });

  test("does NOT read the old .ccqa/prompts/run-nd.user.md path", async () => {
    const dir = await makeWorkspace();
    await writeFile(
      join(dir, ".ccqa/prompts/run-nd.user.md"),
      "legacy content",
      "utf-8",
    );
    expect(await loadLivePromptBundle(dir)).toBeNull();
  });
});
