import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, expect } from "vitest";
import { parseBlockPath, parseSpecPath, getCcqaDir, getFeatureDir, getSpecDir, loadPromptBundle, listActiveSpecs, resolveSpecTargets } from "./index.ts";
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

  test("does not match block recordings (v0.4 inlines blocks per spec)", () => {
    expect(parseBlockPath(".ccqa/blocks/login/actions.json")).toBeNull();
    expect(parseBlockPath(".ccqa/blocks/login/ir.json")).toBeNull();
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

describe("loadPromptBundle", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "ccqa-prompts-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeLocal(name: string, text: string): Promise<void> {
    await mkdir(join(cwd, ".ccqa/prompts"), { recursive: true });
    await writeFile(join(cwd, ".ccqa/prompts", `${name}.md`), text, "utf8");
  }

  test("returns null when there's no hub client and nothing local", async () => {
    expect(await loadPromptBundle(null, "live", cwd)).toBeNull();
  });

  test("returns null when the hub has neither prompt stored", async () => {
    const hub = fakeHubClient(async () => null);
    expect(await loadPromptBundle({ hub, project: "demo" }, "record", cwd)).toBeNull();
  });

  test("assembles a combined bundle with hub prompt names as `loaded` labels", async () => {
    const hub = fakeHubClient(async (_project, name) =>
      name === "live.user" ? "Stable rule." : name === "live.agent" ? "Learned hint." : null,
    );
    const out = await loadPromptBundle({ hub, project: "demo" }, "live", cwd);
    expect(out).not.toBeNull();
    expect(out!.loaded).toEqual(["live.user", "live.agent"]);
    expect(out!.text).toContain("Stable rule.");
    expect(out!.text).toContain("Learned hint.");
  });

  // The project's own copy is the one a reviewer sees beside the tests it
  // governs; the two are prose and concatenating them would contradict.
  test("the project's own `.user` answers instead of the hub's, and says so", async () => {
    await writeLocal("live.user", "What this project does.");
    const hub = fakeHubClient(async (_project, name) =>
      name === "live.user" ? "What the hub says." : name === "live.agent" ? "Learned hint." : null,
    );
    const out = await loadPromptBundle({ hub, project: "demo" }, "live", cwd);
    expect(out!.text).toContain("What this project does.");
    expect(out!.text).not.toContain("What the hub says.");
    expect(out!.loaded).toEqual(["live.user (local)", "live.agent"]);
  });

  test("a project with no hub still gets its own `.user`", async () => {
    await writeLocal("record.user", "What this project does.");
    const out = await loadPromptBundle(null, "record", cwd);
    expect(out!.text).toContain("What this project does.");
    expect(out!.loaded).toEqual(["record.user (local)"]);
  });

  test("propagates a hub failure rather than running without the stored guidance", async () => {
    const hub = fakeHubClient(async () => {
      throw new Error("network error");
    });
    await expect(loadPromptBundle({ hub, project: "demo" }, "record", cwd)).rejects.toThrow("network error");
  });
});

describe("listActiveSpecs", () => {
  async function tree(specs: Array<[string, string]>): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = await mkdtemp(join(tmpdir(), "ccqa-active-specs-"));
    for (const [name, body] of specs) {
      const dir = join(cwd, ".ccqa", "features", "f", "test-cases", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "spec.yaml"), body);
    }
    return cwd;
  }
  const spec = (extra = "") => `title: T\n${extra}steps:\n  - instruction: go\n    expected: there\n`;

  test("leaves out the specs marked disabled", async () => {
    const cwd = await tree([
      ["on", spec()],
      ["off", spec("disabled: true\n")],
      ["explicitly-on", spec("disabled: false\n")],
    ]);
    const names = (await listActiveSpecs(cwd)).map((r) => r.specName).sort();
    expect(names).toEqual(["explicitly-on", "on"]);
  });

  test("expands a feature to its active specs, since a feature name is a group", async () => {
    const cwd = await tree([
      ["on", spec()],
      ["off", spec("disabled: true\n")],
    ]);
    const names = (await resolveSpecTargets("f", () => listActiveSpecs(cwd), cwd)).map((r) => r.specName);
    expect(names).toEqual(["on"]);
  });

  // The escape hatch: a spec id names one spec, so the flag does not lock it.
  test("runs a disabled spec when it is named", async () => {
    const cwd = await tree([["off", spec("disabled: true\n")]]);
    const refs = await resolveSpecTargets("f/off", () => listActiveSpecs(cwd), cwd);
    expect(refs).toEqual([{ featureName: "f", specName: "off" }]);
  });

  test("keeps a spec it cannot parse", async () => {
    const cwd = await tree([["broken", "not: [valid yaml"]]);
    expect((await listActiveSpecs(cwd)).map((r) => r.specName)).toEqual(["broken"]);
  });
});

describe("saveRecording", () => {
  test("writes ir.json (with provenance) and removes legacy actions.json / route.md", async () => {
    const { mkdtemp, mkdir, writeFile, readFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveRecording, specCase } = await import("./index.ts");

    const cwd = await mkdtemp(join(tmpdir(), "ccqa-save-recording-"));
    const specDir = join(cwd, ".ccqa", "features", "demo", "test-cases", "x");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "actions.json"), "[]", "utf8");
    await writeFile(join(specDir, "route.md"), "# legacy", "utf8");

    const { path, recording } = await saveRecording(specCase("demo", "x", cwd), [{ action: "navigate", value: "https://example.test" }]);

    expect(recording.actions).toHaveLength(1);
    expect(recording.origin).toBe("https://example.test");
    expect(JSON.parse(await readFile(path, "utf8")).actions).toHaveLength(1);
    await expect(stat(join(specDir, "actions.json"))).rejects.toThrow();
    await expect(stat(join(specDir, "route.md"))).rejects.toThrow();
  });

  test("a successful save removes a leftover ir.failed.json", async () => {
    const { mkdtemp, mkdir, writeFile, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveRecording, specCase } = await import("./index.ts");

    const cwd = await mkdtemp(join(tmpdir(), "ccqa-save-recording-"));
    const specDir = join(cwd, ".ccqa", "features", "demo", "test-cases", "x");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "ir.failed.json"), "[]", "utf8");

    await saveRecording(specCase("demo", "x", cwd), [{ action: "navigate", value: "https://example.test" }]);

    await expect(stat(join(specDir, "ir.failed.json"))).rejects.toThrow();
  });
});

describe("stampGeneratedTest", () => {
  test("records what the generation wrote, and leaves the route untouched", async () => {
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveRecording, specCase, stampGeneratedTest, fileSha256 } = await import("./index.ts");

    const cwd = await mkdtemp(join(tmpdir(), "ccqa-stamp-"));
    const specDir = join(cwd, ".ccqa", "features", "demo", "test-cases", "x");
    await mkdir(specDir, { recursive: true });
    const { path } = await saveRecording(specCase("demo", "x", cwd), [{ action: "navigate", value: "https://example.test" }]);
    const testFile = join(specDir, "test.spec.ts");
    await writeFile(testFile, "test('flow', () => {});\n", "utf8");

    await stampGeneratedTest(specCase("demo", "x", cwd), testFile);

    const recording = JSON.parse(await readFile(path, "utf8"));
    expect(recording.generated.testSha256).toBe(await fileSha256(testFile));
    expect(Date.parse(recording.generated.at)).not.toBeNaN();
    // The route itself is what the trace wrote; a stamp must not disturb it.
    expect(recording.actions).toEqual([{ action: "navigate", value: "https://example.test" }]);
  });

  test("stamps nothing when the generation produced no test", async () => {
    const { mkdtemp, mkdir, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveRecording, specCase, stampGeneratedTest } = await import("./index.ts");

    const cwd = await mkdtemp(join(tmpdir(), "ccqa-stamp-"));
    await mkdir(join(cwd, ".ccqa", "features", "demo", "test-cases", "x"), { recursive: true });
    const { path } = await saveRecording(specCase("demo", "x", cwd), [{ action: "click" }]);

    await stampGeneratedTest(specCase("demo", "x", cwd), join(cwd, "nope.spec.ts"));

    expect(JSON.parse(await readFile(path, "utf8")).generated).toBeUndefined();
  });
});

describe("parseRecording", () => {
  test("reads a bare action array as a route with no provenance", async () => {
    const { parseRecording } = await import("./index.ts");
    const recording = parseRecording(`[{"action":"navigate","value":"https://example.test"}]`);
    expect(recording.actions).toHaveLength(1);
    expect(recording.recordedAt).toBeUndefined();
  });

  test("rejects a file holding no action list, naming what to do", async () => {
    const { parseRecording } = await import("./index.ts");
    expect(() => parseRecording(`{"recordedAt":"2026-01-01T00:00:00.000Z"}`)).toThrow(
      /no `actions` array/,
    );
  });
});

describe("saveFailedRecording", () => {
  test("writes ir.failed.json and leaves ir.json untouched", async () => {
    const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveFailedRecording, specCase } = await import("./index.ts");

    const cwd = await mkdtemp(join(tmpdir(), "ccqa-save-failed-"));
    const specDir = join(cwd, ".ccqa", "features", "demo", "test-cases", "x");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "ir.json"), '[{"action":"navigate","value":"https://good.test"}]', "utf8");

    const path = await saveFailedRecording(specCase("demo", "x", cwd), []);

    expect(path).toBe(join(specDir, "ir.failed.json"));
    expect(JSON.parse(await readFile(path, "utf8")).actions).toHaveLength(0);
    // The good recording survives the failed trace.
    expect(JSON.parse(await readFile(join(specDir, "ir.json"), "utf8"))).toHaveLength(1);
  });
});
