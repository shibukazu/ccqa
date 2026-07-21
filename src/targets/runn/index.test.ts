import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { generateRunnRunbook, validateRunnFile } from "./index.ts";
import { TargetConfigSchema } from "../../config/project-config.ts";
import { TestSpecSchema } from "../../spec/yaml-schema.ts";
import type { InvokeFn } from "../llm-engine.ts";
import type { GenerateContext } from "../types.ts";

let cwd: string;

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function makeContext(): GenerateContext {
  const spec = TestSpecSchema.parse({
    title: "create a task via the API",
    target: "runn",
    relatedPaths: ["server/routes/**"],
    steps: [{ instruction: "POST a new task", expected: "201 with the task id" }],
  });
  return {
    spec,
    specYaml: "title: create a task via the API\n",
    featureName: "tasks",
    specName: "create",
    cwd,
    resources: [],
    conventions: { guides: [], examples: [] },
    targetConfig: TargetConfigSchema.parse({ outDir: "runbooks" }),
    language: "auto",
    hub: null,
    fix: { maxRetries: 0, mode: "auto", useSnapshot: false },
  };
}

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

const VALID_RUNBOOK = `desc: create a task
runners:
  req: \${API_ENDPOINT}
steps:
  - req:
      /tasks:
        post:
          body:
            application/json:
              title: sample
  - test: current.res.status == 201
`;

describe("validateRunnFile", () => {
  it("accepts parseable YAML runbooks", () => {
    expect(
      validateRunnFile({ path: "runbooks/a.yaml", contents: VALID_RUNBOOK, kind: "test" }),
    ).toBeNull();
    expect(
      validateRunnFile({ path: "runbooks/h.yml", contents: "desc: x\n", kind: "support" }),
    ).toBeNull();
  });

  it("rejects non-YAML paths and broken YAML bodies", () => {
    expect(validateRunnFile({ path: "runbooks/a.ts", contents: "x", kind: "test" })).toMatch(
      /must be a YAML runbook/,
    );
    expect(
      validateRunnFile({ path: "runbooks/a.yaml", contents: "desc: [broken", kind: "test" }),
    ).toMatch(/not valid YAML/);
  });
});

describe("runn target generate", () => {
  it("writes a parse-validated runbook via the LLM engine", async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-runn-")));
    const output = JSON.stringify({
      files: [{ path: "runbooks/tasks/create.yaml", contents: VALID_RUNBOOK, kind: "test" }],
      summary: "runbook generated",
    });
    const { invoke, prompts } = fakeInvoke([output]);
    const result = await generateRunnRunbook(makeContext(), invoke);

    expect(result.passed).toBe(true);
    const written = await readFile(resolve(cwd, "runbooks/tasks/create.yaml"), "utf8");
    expect(parseYaml(written)).toMatchObject({ desc: "create a task" });
    // The prompt prescribes the generic runbook shape and points at relatedPaths.
    expect(prompts[0]).toContain("runn runbook");
    expect(prompts[0]).toContain("server/routes/**");
  });

  it("rejects broken YAML before writing (contract retries, then error)", async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-runn-")));
    const broken = JSON.stringify({
      files: [{ path: "runbooks/tasks/create.yaml", contents: "desc: [broken", kind: "test" }],
      summary: "",
    });
    const { invoke, prompts } = fakeInvoke([broken]);
    await expect(generateRunnRunbook(makeContext(), invoke)).rejects.toThrow(/not valid YAML/);
    expect(prompts).toHaveLength(3);
    await expect(readFile(resolve(cwd, "runbooks/tasks/create.yaml"), "utf8")).rejects.toThrow();
  });
});
