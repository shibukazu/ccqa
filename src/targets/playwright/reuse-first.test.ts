import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { playwrightTarget } from "./index.ts";
import { loadProjectConfig, TargetConfigSchema } from "../../config/project-config.ts";
import { parseTestSpec } from "../../spec/parser.ts";
import { GENERATED_MANIFEST_FILE } from "../run-command-runner.ts";
import type { RecordedAction } from "../../ir/types.ts";
import type { GenerateContext } from "../types.ts";

/**
 * The reuse-first fixture test: a neutral todo-app project declares path
 * resources (`e2e/pages`, `e2e/steps`) and a pseudo-package resource
 * (`@example/e2e-kit` inside the fixture's own node_modules). With Claude
 * mocked via CCQA_CLAUDE_MOCK_FILE (the real invoke seam), the playwright
 * target must resolve every resource, run the LLM pass, and land a generated
 * spec that imports BOTH the path assets and the package asset.
 */

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../tests/e2e/fixtures/reuse-first/", import.meta.url),
);

// What the mocked Claude "generates": a spec importing the page object and
// step helper (path resources) plus the shared kit (package resource), and
// one new support page object under the writable e2e/pages root.
const GENERATED_SPEC = `import { test, expect } from "@playwright/test";
import { TodoListPage, TODO_ITEM_TESTID } from "../pages/todo_list";
import { TodoHeader } from "../pages/todo_header";
import { login } from "../steps/login";
import { withSignedInUser, RUN_LABEL_PATTERN } from "@example/e2e-kit";

test("add a todo item", async ({ page }) => {
  await page.goto(process.env.APP_URL ?? "");
  await login(page, process.env.TEST_EMAIL ?? "", process.env.TEST_PASSWORD ?? "");
  const list = new TodoListPage(page);
  await list.addItem("buy milk");
  await expect(page.getByTestId(TODO_ITEM_TESTID).first()).toBeVisible();
});
`;

const SUPPORT_PAGE = `// New page object created because no resource covered the header.
export class TodoHeader {}
`;

const MOCK_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify({
    files: [
      { path: "e2e/specs/todos/add-item.spec.ts", contents: GENERATED_SPEC, kind: "test" },
      { path: "e2e/pages/todo_header.ts", contents: SUPPORT_PAGE, kind: "support" },
    ],
    summary: "rewrote the draft to reuse TodoListPage, login, and @example/e2e-kit",
  }),
});

let cwd: string;

afterEach(async () => {
  delete process.env.CCQA_CLAUDE_MOCK_FILE;
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("playwright target — reuse-first generation (mocked Claude)", () => {
  it("imports both path-resource and package-resource assets in the generated spec", async () => {
    // Copy the fixture so generated output never dirties the repo tree.
    cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-reuse-first-")));
    await cp(FIXTURE_DIR, cwd, { recursive: true });

    const mockPath = join(cwd, "claude-mock.jsonl");
    await writeFile(mockPath, MOCK_RESULT + "\n", "utf8");
    process.env.CCQA_CLAUDE_MOCK_FILE = mockPath;

    const specDir = join(cwd, ".ccqa/features/todos/test-cases/add-item");
    const specYaml = await readFile(join(specDir, "spec.yaml"), "utf8");
    const recording = JSON.parse(
      await readFile(join(specDir, "ir.json"), "utf8"),
    ) as RecordedAction[];
    const config = await loadProjectConfig(cwd);
    const targetConfig = config.targets["playwright"] ?? TargetConfigSchema.parse({});

    const ctx: GenerateContext = {
      spec: parseTestSpec(specYaml),
      specYaml,
      featureName: "todos",
      specName: "add-item",
      cwd,
      recording,
      resources: targetConfig.resources,
      conventions: targetConfig.conventions,
      targetConfig,
      language: "auto",
      hub: null,
      fix: { maxRetries: 0, mode: "auto", useSnapshot: false },
    };

    const result = await playwrightTarget.generate(ctx);
    expect(result.passed).toBe(true);

    const generated = await readFile(resolve(cwd, "e2e/specs/todos/add-item.spec.ts"), "utf8");
    // The core assertion: the generated test reuses BOTH resource kinds.
    expect(generated).toContain(`from "../pages/todo_list"`);
    expect(generated).toContain(`from "../steps/login"`);
    expect(generated).toContain(`from "@example/e2e-kit"`);

    // The missing part landed as a support file under the path-resource root.
    expect(await readFile(resolve(cwd, "e2e/pages/todo_header.ts"), "utf8")).toContain(
      "TodoHeader",
    );

    const manifest = JSON.parse(await readFile(join(specDir, GENERATED_MANIFEST_FILE), "utf8"));
    expect(manifest.target).toBe("playwright");
    expect(manifest.files.map((f: { path: string; kind: string }) => [f.path, f.kind])).toEqual([
      ["e2e/specs/todos/add-item.spec.ts", "test"],
      ["e2e/pages/todo_header.ts", "support"],
    ]);

    // existingOutput now reports the generated spec for the overwrite guard.
    expect(await playwrightTarget.existingOutput?.({ featureName: "todos", specName: "add-item" }, cwd)).toBe(
      resolve(cwd, "e2e/specs/todos/add-item.spec.ts"),
    );
  });
});
