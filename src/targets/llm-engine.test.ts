import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  existingOutputFromManifest,
  finalizePreparedFiles,
  generateWithLlmEngine,
  parseLlmGenOutput,
  substituteRunCommandFiles,
  validateOutputPath,
  type InvokeFn,
} from "./llm-engine.ts";
import { GENERATED_MANIFEST_FILE } from "./run-command-runner.ts";
import { TargetConfigSchema } from "../config/project-config.ts";
import { TestSpecSchema } from "../spec/yaml-schema.ts";
import type { GenerateContext } from "./types.ts";

let cwd: string;

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-llm-engine-")));
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(cwd, path);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return cwd;
}

function makeContext(overrides: Partial<GenerateContext> = {}): GenerateContext {
  const spec = TestSpecSchema.parse({
    title: "add a todo item",
    steps: [{ instruction: "open the list page", expected: "the empty list is shown" }],
  });
  return {
    spec,
    specYaml: "title: add a todo item\n",
    featureName: "todos",
    specName: "add-item",
    cwd,
    resources: [],
    conventions: { guides: [], examples: [] },
    targetConfig: TargetConfigSchema.parse({ outDir: "e2e" }),
    language: "auto",
    hub: null,
    fix: { maxRetries: 1, mode: "auto", useSnapshot: false },
    ...overrides,
  };
}

/** InvokeFn returning canned results in order (last one repeats), capturing prompts. */
function fakeInvoke(results: string[]): { invoke: InvokeFn; prompts: string[] } {
  const prompts: string[] = [];
  const invoke: InvokeFn = async (options) => {
    prompts.push(options.prompt);
    const result = results[Math.min(prompts.length - 1, results.length - 1)] ?? "";
    return {
      result,
      isError: false,
      cost: {
        totalCostUsd: null,
        durationMs: null,
        durationApiMs: null,
        numTurns: null,
        inputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        outputTokens: null,
        models: [],
      },
    };
  };
  return { invoke, prompts };
}

const okOutput = (path = "e2e/todos/add-item.spec.ts"): string =>
  JSON.stringify({
    files: [{ path, contents: "// generated test\n", kind: "test" }],
    summary: "one spec generated",
  });

describe("parseLlmGenOutput", () => {
  it("parses a bare JSON object and a fenced one", () => {
    expect(parseLlmGenOutput(okOutput()).files).toHaveLength(1);
    expect(parseLlmGenOutput("```json\n" + okOutput() + "\n```").summary).toBe(
      "one spec generated",
    );
  });

  it("tolerates prose around the JSON object", () => {
    const raw = `Here is the result:\n${okOutput()}\nDone.`;
    expect(parseLlmGenOutput(raw).files[0]!.kind).toBe("test");
  });

  it("throws on non-JSON and on a schema mismatch", () => {
    expect(() => parseLlmGenOutput("no json here")).toThrow(/no JSON object/);
    expect(() => parseLlmGenOutput(`{"summary": "x"}`)).toThrow(/does not match/);
    expect(() => parseLlmGenOutput(`{"files": [{"path": "a", "kind": "test"}]}`)).toThrow(
      /contents/,
    );
  });

  it("parses an empty files array (fix-pass 'no change needed' reply)", () => {
    const out = parseLlmGenOutput(`{"files": [], "summary": "environment issue"}`);
    expect(out.files).toHaveLength(0);
    expect(out.summary).toBe("environment issue");
  });

  it("coerces an unknown or missing kind to \"test\" with a warning", () => {
    const raw = JSON.stringify({
      files: [
        { path: "runbooks/a.yaml", contents: "desc: x\n", kind: "runbook" },
        { path: "runbooks/b.yaml", contents: "desc: y\n" },
        { path: "pages/p.ts", contents: "// helper\n", kind: "support" },
      ],
      summary: "s",
    });
    const out = parseLlmGenOutput(raw);
    expect(out.files.map((f) => f.kind)).toEqual(["test", "test", "support"]);
    expect(out.kindWarnings).toHaveLength(1);
    expect(out.kindWarnings[0]).toMatch(/runbook/);
  });
});

describe("validateOutputPath", () => {
  const policy = {
    cwd: "/repo",
    outDirAbs: "/repo/e2e",
    writeRootsAbs: ["/repo/pages"],
  };

  it("accepts paths under outDir and under a writable resource root", () => {
    expect(validateOutputPath(policy, "e2e/a.spec.ts")).toBeNull();
    expect(validateOutputPath(policy, "e2e/nested/b.spec.ts")).toBeNull();
    expect(validateOutputPath(policy, "pages/new_page.ts")).toBeNull();
  });

  it("rejects absolute paths, traversal, node_modules, and escapes", () => {
    expect(validateOutputPath(policy, "/etc/passwd")).toMatch(/absolute/);
    expect(validateOutputPath(policy, "e2e/../../outside.ts")).toMatch(/traversal/);
    expect(validateOutputPath(policy, "e2e/node_modules/x.ts")).toMatch(/node_modules/);
    expect(validateOutputPath(policy, "src/app.ts")).toMatch(/escapes the allowed roots/);
  });

  it("rejects shell-unsafe characters (defense in depth for shell:true runCommands)", () => {
    for (const p of ["e2e/a$(rm x).ts", "e2e/a;b.ts", "e2e/a`b`.ts", "e2e/a|b.ts", "e2e/a\nb.ts"]) {
      expect(validateOutputPath(policy, p)).toMatch(/shell-unsafe/);
    }
    expect(validateOutputPath(policy, "e2e/spaced name.spec.ts")).toBeNull();
  });
});

describe("substituteRunCommandFiles", () => {
  it("replaces {files} with shell-quoted test paths", () => {
    expect(substituteRunCommandFiles("run {files}", ["a.yaml", "dir/b c.yaml"])).toBe(
      "run a.yaml 'dir/b c.yaml'",
    );
    expect(substituteRunCommandFiles("make verify", ["a.yaml"])).toBe("make verify");
  });
});

describe("generateWithLlmEngine", () => {
  it("writes the returned files and a sha256 manifest, and reports passed without a runCommand", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext(),
      target: "playwright",
      taskInstructions: "Generate the test.",
      draft: { path: "e2e/todos/add-item.spec.ts", contents: "// draft" },
      invoke,
    });

    expect(result.passed).toBe(true);
    expect(result.summary).toBe("one spec generated");
    expect(result.files).toEqual([
      { path: resolve(cwd, "e2e/todos/add-item.spec.ts"), kind: "test" },
    ]);
    expect(await readFile(result.files[0]!.path, "utf8")).toBe("// generated test\n");

    const manifest = JSON.parse(
      await readFile(
        join(cwd, ".ccqa/features/todos/test-cases/add-item", GENERATED_MANIFEST_FILE),
        "utf8",
      ),
    );
    expect(manifest.target).toBe("playwright");
    expect(manifest.files).toEqual([
      {
        path: "e2e/todos/add-item.spec.ts",
        kind: "test",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

    // The prompt carries the spec, the draft, and the reuse/output contracts.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("add a todo item");
    expect(prompts[0]).toContain("// draft");
    expect(prompts[0]).toContain("Reuse contract");
    expect(prompts[0]).toContain("Output format");
  });

  it("retries once on an unparseable reply, feeding the error back", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke(["not json at all", okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext(),
      target: "playwright",
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous attempt rejected");
    expect(prompts[1]).toContain("no JSON object");
  });

  it("errors after all contract retries fail", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke(["garbage"]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext(),
        target: "playwright",
        taskInstructions: "Generate the test.",
        invoke,
      }),
    ).rejects.toThrow(/LLM generation failed after 2 retries/);
    expect(prompts).toHaveLength(3);
  });

  it("rejects output paths outside the allowed roots (then errors after retry)", async () => {
    await makeProject();
    const bad = JSON.stringify({
      files: [{ path: "../outside.spec.ts", contents: "x", kind: "test" }],
      summary: "",
    });
    const { invoke } = fakeInvoke([bad]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext(),
        target: "playwright",
        taskInstructions: "Generate the test.",
        invoke,
      }),
    ).rejects.toThrow(/traversal/);
    await expect(stat(resolve(cwd, "../outside.spec.ts"))).rejects.toThrow();
  });

  it("requires at least one test-kind file", async () => {
    await makeProject();
    const supportOnly = JSON.stringify({
      files: [{ path: "e2e/helper.ts", contents: "x", kind: "support" }],
      summary: "",
    });
    const { invoke } = fakeInvoke([supportOnly]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext(),
        target: "playwright",
        taskInstructions: "Generate the test.",
        invoke,
      }),
    ).rejects.toThrow(/no "kind": "test" file/);
  });

  it("defaults the write root to the spec directory when outDir is not configured", async () => {
    await makeProject();
    const specDirTest = ".ccqa/features/todos/test-cases/add-item/test.spec.ts";
    const { invoke } = fakeInvoke([okOutput(specDirTest)]);
    const res = await generateWithLlmEngine({
      ctx: makeContext({ targetConfig: TargetConfigSchema.parse({}) }),
      target: "playwright",
      taskInstructions: "x",
      invoke,
    });
    expect(res.files.map((f) => relative(cwd, f.path))).toEqual([specDirTest]);

    // ...and a path outside the spec directory is rejected by the policy.
    const { invoke: badInvoke } = fakeInvoke([okOutput("e2e/todos/add-item.spec.ts")]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext({ targetConfig: TargetConfigSchema.parse({}) }),
        target: "playwright",
        taskInstructions: "x",
        invoke: badInvoke,
      }),
    ).rejects.toThrow(/escapes the allowed roots/);
  });

  it("runs the fix loop until the runCommand passes", async () => {
    await makeProject();
    // The verification command passes only once the fix pass writes the marker file.
    const fixed = JSON.stringify({
      files: [{ path: "e2e/fixed.marker", contents: "ok", kind: "support" }],
      summary: "fixed",
    });
    const { invoke, prompts } = fakeInvoke([okOutput(), fixed]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({
          outDir: "e2e",
          runCommand: "test -f e2e/fixed.marker # {files}",
        }),
      }),
      target: "playwright",
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("verification run failed");
    expect(prompts[1]).toContain("Failing command");
    // The fix pass merged the new file alongside the original.
    expect(result.files.map((f) => f.path).sort()).toEqual([
      resolve(cwd, "e2e/fixed.marker"),
      resolve(cwd, "e2e/todos/add-item.spec.ts"),
    ]);
  });

  it("keeps files and reports passed: false when fixes are exhausted", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ outDir: "e2e", runCommand: "false" }),
      }),
      target: "playwright",
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(false);
    // initial generation + maxRetries(1) fix request
    expect(prompts).toHaveLength(2);
    expect(await readFile(resolve(cwd, "e2e/todos/add-item.spec.ts"), "utf8")).toBe(
      "// generated test\n",
    );
  });

  it("degrades an unusable fix reply to a failed attempt instead of aborting the generate", async () => {
    await makeProject();
    // The fix pass never produces valid output; the generate must still
    // finish (passed: false) with the original files intact, not throw.
    const { invoke, prompts } = fakeInvoke([okOutput(), "not json"]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ outDir: "e2e", runCommand: "false" }),
      }),
      target: "playwright",
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(false);
    // initial generation + the fix pass's contract attempts (1 + 2 retries)
    expect(prompts).toHaveLength(4);
    expect(await readFile(resolve(cwd, "e2e/todos/add-item.spec.ts"), "utf8")).toBe(
      "// generated test\n",
    );
  });

  it("resolves resources/conventions into the prompt and allows support files under path roots", async () => {
    await makeProject({
      "e2e/pages/todo_list.ts": "export class TodoListPage {}",
      "docs/style.md": "always use page objects",
      "node_modules/@acme/e2e-kit/package.json": JSON.stringify({ name: "@acme/e2e-kit" }),
    });
    const output = JSON.stringify({
      files: [
        { path: "e2e/specs/add-item.spec.ts", contents: "// test", kind: "test" },
        { path: "e2e/pages/todo_detail.ts", contents: "// new page object", kind: "support" },
      ],
      summary: "spec + support",
    });
    const { invoke, prompts } = fakeInvoke([output]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        resources: [
          { path: "e2e/pages", description: "page objects" },
          { package: "@acme/e2e-kit", description: "shared fixtures" },
        ],
        conventions: { guides: ["docs/style.md"], examples: [] },
        targetConfig: TargetConfigSchema.parse({ outDir: "e2e/specs" }),
      }),
      target: "playwright",
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(true);
    expect(await readFile(resolve(cwd, "e2e/pages/todo_detail.ts"), "utf8")).toBe(
      "// new page object",
    );
    expect(prompts[0]).toContain("repo code `e2e/pages` — page objects");
    expect(prompts[0]).toContain("npm package `@acme/e2e-kit` — shared fixtures");
    expect(prompts[0]).toContain("always use page objects");
  });
});

describe("existingOutputFromManifest", () => {
  it("returns a still-existing generated file, or null when absent", async () => {
    await makeProject();
    const ref = { featureName: "todos", specName: "add-item" };
    expect(await existingOutputFromManifest(ref, cwd)).toBeNull();

    const { invoke } = fakeInvoke([okOutput()]);
    await generateWithLlmEngine({
      ctx: makeContext(),
      target: "playwright",
      taskInstructions: "x",
      invoke,
    });
    expect(await existingOutputFromManifest(ref, cwd)).toBe(
      resolve(cwd, "e2e/todos/add-item.spec.ts"),
    );

    await rm(resolve(cwd, "e2e/todos/add-item.spec.ts"));
    expect(await existingOutputFromManifest(ref, cwd)).toBeNull();
  });
});

describe("finalizePreparedFiles", () => {
  it("shares the write + manifest + verification half for prepared files", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([]);
    const result = await finalizePreparedFiles({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ outDir: "e2e", runCommand: "exit 0" }),
      }),
      target: "playwright",
      files: [{ path: "e2e/draft.spec.ts", contents: "// draft", kind: "test" }],
      summary: "mechanical draft",
      warnings: [],
      invoke,
    });
    expect(result.passed).toBe(true);
    expect(prompts).toHaveLength(0); // verification passed — no LLM involved
    expect(await readFile(resolve(cwd, "e2e/draft.spec.ts"), "utf8")).toBe("// draft");
    const manifestPath = join(
      cwd,
      ".ccqa/features/todos/test-cases/add-item",
      GENERATED_MANIFEST_FILE,
    );
    expect(JSON.parse(await readFile(manifestPath, "utf8")).files).toHaveLength(1);
  });
});
