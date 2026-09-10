import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { specCase } from "../store/index.ts";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The interactive fix gate confirms via draft.ts's `prompt`; stub it so tests
// can answer y/N without stdin. printUnifiedDiff stays real (harmless output).
vi.mock("../cli/draft.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/draft.ts")>();
  return { ...actual, prompt: vi.fn(async () => "n") };
});
const { prompt: mockedPrompt } = await import("../cli/draft.ts");
import {
  finalizePreparedFiles,
  generateWithLlmEngine,
  parseLlmGenOutput,
  substituteRunCommandFiles,
  validateOutputPath,
  type InvokeFn,
} from "./llm-engine.ts";
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
    ref: specCase("todos", "add-item", cwd),
    steps: [],
    cleanup: [],
    fields: {},
    cwd,
    testPath: "e2e/todos/add-item.spec.ts",
    resources: [],
    conventions: { guides: [], examples: [], record: [] },
    targetConfig: TargetConfigSchema.parse({}),
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
      errorDetail: null,
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
    testPath: "e2e/a.spec.ts",
    writeRootsAbs: ["/repo/pages"],
  };

  it("accepts the test file at its configured testPath, and support files under the test's directory or a writable resource root", () => {
    expect(validateOutputPath(policy, "e2e/a.spec.ts", "test")).toBeNull();
    expect(validateOutputPath(policy, "e2e/nested/b.spec.ts", "support")).toBeNull();
    expect(validateOutputPath(policy, "pages/new_page.ts", "support")).toBeNull();
  });

  it("rejects a test-kind file anywhere other than the configured testPath", () => {
    expect(validateOutputPath(policy, "e2e/other.spec.ts", "test")).toMatch(/must be written to/);
  });

  it("rejects absolute paths, traversal, node_modules, and escapes", () => {
    expect(validateOutputPath(policy, "/etc/passwd", "support")).toMatch(/absolute/);
    expect(validateOutputPath(policy, "e2e/../../outside.ts", "support")).toMatch(/traversal/);
    expect(validateOutputPath(policy, "e2e/node_modules/x.ts", "support")).toMatch(/node_modules/);
    expect(validateOutputPath(policy, "src/app.ts", "support")).toMatch(/escapes the allowed roots/);
  });

  it("rejects shell-unsafe characters (defense in depth for shell:true runCommands)", () => {
    for (const p of ["e2e/a$(rm x).ts", "e2e/a;b.ts", "e2e/a`b`.ts", "e2e/a|b.ts", "e2e/a\nb.ts"]) {
      expect(validateOutputPath(policy, p, "support")).toMatch(/shell-unsafe/);
    }
    expect(validateOutputPath(policy, "e2e/spaced name.ts", "support")).toBeNull();
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
  it("writes the returned files and reports passed without a runCommand", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext(),
      target: "playwright",
      steps: [],
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
      steps: [],
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
        steps: [],
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
        steps: [],
        taskInstructions: "Generate the test.",
        invoke,
      }),
    ).rejects.toThrow(/traversal/);
    await expect(stat(resolve(cwd, "../outside.spec.ts"))).rejects.toThrow();
  });

  it("requires at least one test-kind file", async () => {
    await makeProject();
    const supportOnly = JSON.stringify({
      files: [{ path: "e2e/todos/helper.ts", contents: "x", kind: "support" }],
      summary: "",
    });
    const { invoke } = fakeInvoke([supportOnly]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext(),
        target: "playwright",
        steps: [],
        taskInstructions: "Generate the test.",
        invoke,
      }),
    ).rejects.toThrow(/no "kind": "test" file/);
  });

  it("rejects a test-kind file written anywhere other than the configured testPath", async () => {
    await makeProject();
    const { invoke: badInvoke } = fakeInvoke([okOutput("e2e/somewhere-else.spec.ts")]);
    await expect(
      generateWithLlmEngine({
        ctx: makeContext(),
        target: "playwright",
        steps: [],
        taskInstructions: "x",
        invoke: badInvoke,
      }),
    ).rejects.toThrow(/must be written to/);

    // The valid path (matching ctx.testPath) still writes normally.
    const specDirTest = ".ccqa/features/todos/test-cases/add-item/test.spec.ts";
    const { invoke } = fakeInvoke([okOutput(specDirTest)]);
    const res = await generateWithLlmEngine({
      ctx: makeContext({ testPath: specDirTest }),
      target: "playwright",
      steps: [],
      taskInstructions: "x",
      invoke,
    });
    expect(res.files.map((f) => relative(cwd, f.path))).toEqual([specDirTest]);
  });

  it("fails the project's own checks even when the spec's test passed", async () => {
    await makeProject();
    const { invoke } = fakeInvoke([okOutput(), okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({
          runCommand: "exit 0",
          // What a project's type check or lint is to ccqa: a command that
          // must also pass before the generated file is worth reviewing.
          checkCommands: ["exit 3"],
        }),
      }),
      target: "playwright",
      steps: [],
      taskInstructions: "x",
      invoke,
    });
    expect(result.passed).toBe(false);
  });

  it("runs the fix loop until the runCommand passes", async () => {
    await makeProject();
    // The verification command passes only once the fix pass writes the marker file.
    const fixed = JSON.stringify({
      files: [{ path: "e2e/todos/fixed.marker", contents: "ok", kind: "support" }],
      summary: "fixed",
    });
    const { invoke, prompts } = fakeInvoke([okOutput(), fixed]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({
          runCommand: "test -f e2e/todos/fixed.marker # {files}",
        }),
      }),
      target: "playwright",
      steps: [],
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("verification run failed");
    expect(prompts[1]).toContain("Failing command");
    // The fix pass merged the new file alongside the original.
    expect(result.files.map((f) => f.path).sort()).toEqual([
      resolve(cwd, "e2e/todos/add-item.spec.ts"),
      resolve(cwd, "e2e/todos/fixed.marker"),
    ]);
  });

  it("keeps files and reports passed: false when fixes are exhausted", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ runCommand: "false" }),
      }),
      target: "playwright",
      steps: [],
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

  it("--auto-fix skip (non-interactive) runs verification once and never requests a fix", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([okOutput()]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        fix: { maxRetries: 3, mode: "non-interactive", useSnapshot: false },
        targetConfig: TargetConfigSchema.parse({ runCommand: "false" }),
      }),
      target: "playwright",
      steps: [],
      taskInstructions: "Generate the test.",
      invoke,
    });
    expect(result.passed).toBe(false);
    // Only the initial generation — the fix pass is disabled, so no second call.
    expect(prompts).toHaveLength(1);
  });

  it("interactive fix mode shows the diff and does not write the fix when declined at the prompt", async () => {
    await makeProject();
    // Force a TTY so the interactive prompt path runs (not the non-TTY decline).
    const prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      vi.mocked(mockedPrompt).mockResolvedValueOnce("n");
      const fixed = JSON.stringify({
        files: [{ path: "e2e/todos/fixed.marker", contents: "ok", kind: "support" }],
        summary: "fixed",
      });
      const { invoke, prompts } = fakeInvoke([okOutput(), fixed]);
      const result = await generateWithLlmEngine({
        ctx: makeContext({
          fix: { maxRetries: 1, mode: "interactive", useSnapshot: false },
          targetConfig: TargetConfigSchema.parse({
            runCommand: "test -f e2e/todos/fixed.marker # {files}",
          }),
        }),
        target: "playwright",
        steps: [],
        taskInstructions: "Generate the test.",
        invoke,
      });
      // The fix was proposed (LLM called) but declined, so the marker never
      // lands and verification stays red.
      expect(result.passed).toBe(false);
      expect(prompts).toHaveLength(2);
      expect(vi.mocked(mockedPrompt)).toHaveBeenCalled();
      await expect(stat(resolve(cwd, "e2e/todos/fixed.marker"))).rejects.toThrow();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTty, configurable: true });
    }
  });

  it("interactive fix declines without prompting (hanging) on non-TTY stdin", async () => {
    await makeProject();
    vi.mocked(mockedPrompt).mockClear();
    // Ensure no TTY — the guard must decline rather than call prompt (which
    // would hang forever on piped/CI stdin).
    const prevTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    try {
      const fixed = JSON.stringify({
        files: [{ path: "e2e/todos/fixed.marker", contents: "ok", kind: "support" }],
        summary: "fixed",
      });
      const { invoke } = fakeInvoke([okOutput(), fixed]);
      const result = await generateWithLlmEngine({
        ctx: makeContext({
          fix: { maxRetries: 1, mode: "interactive", useSnapshot: false },
          targetConfig: TargetConfigSchema.parse({
            runCommand: "test -f e2e/todos/fixed.marker # {files}",
          }),
        }),
        target: "playwright",
        steps: [],
        taskInstructions: "Generate the test.",
        invoke,
      });
      expect(result.passed).toBe(false);
      expect(vi.mocked(mockedPrompt)).not.toHaveBeenCalled();
      await expect(stat(resolve(cwd, "e2e/todos/fixed.marker"))).rejects.toThrow();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTty, configurable: true });
    }
  });

  it("degrades an unusable fix reply to a failed attempt instead of aborting the generate", async () => {
    await makeProject();
    // The fix pass never produces valid output; the generate must still
    // finish (passed: false) with the original files intact, not throw.
    const { invoke, prompts } = fakeInvoke([okOutput(), "not json"]);
    const result = await generateWithLlmEngine({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ runCommand: "false" }),
      }),
      target: "playwright",
      steps: [],
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
        testPath: "e2e/specs/add-item.spec.ts",
        resources: [
          { path: "e2e/pages", description: "page objects" },
          { package: "@acme/e2e-kit", description: "shared fixtures" },
        ],
        conventions: { guides: ["docs/style.md"], examples: [], record: [] },
      }),
      target: "playwright",
      steps: [],
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

describe("finalizePreparedFiles", () => {
  it("shares the write + verification half for prepared files", async () => {
    await makeProject();
    const { invoke, prompts } = fakeInvoke([]);
    const result = await finalizePreparedFiles({
      ctx: makeContext({
        targetConfig: TargetConfigSchema.parse({ runCommand: "exit 0" }),
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
  });
});
