import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../../config/project-config.ts";
import { resolveCase } from "../../cli/resolve-case.ts";
import type { RecordedAction } from "../../ir/types.ts";
import type { GenerateContext } from "../types.ts";

/**
 * A `kind: external` target composes ccqa's own mechanisms — markdown case
 * parsing, the mechanical Playwright emitter, and (when resources are
 * configured) the reuse-first LLM rewrite — with a project's own config. This
 * fixture is a neutral todo-app project whose `.ccqa/config.yaml` renames the
 * markdown case's step/expected headings, and configures a header template,
 * a priority → title-tag map, and its own run-id helper. With Claude mocked
 * via CCQA_CLAUDE_MOCK_FILE (see reuse-first.test.ts for the same seam), this
 * proves the pieces reach the written file together.
 */
const FIXTURE_DIR = fileURLToPath(
  new URL("../../../tests/e2e/fixtures/external-target/", import.meta.url),
);

/** The recorded route: what `ccqa record` would have produced for the case. */
const RECORDING: RecordedAction[] = [
  { action: "navigate", value: "https://example.test/todo", stepId: "step-01" },
  {
    action: "fill",
    locator: { by: "placeholder", value: "What needs to be done?" },
    value: "buy milk ${CCQA_RUN_ID}",
    stepId: "step-02",
  },
  {
    action: "click",
    locator: { by: "role", value: "button", name: "Add" },
    stepId: "step-03",
  },
  {
    action: "assert",
    assert: "text_visible",
    value: "buy milk ${CCQA_RUN_ID}",
    stepId: "step-04",
  },
];

const CLEANUP_RECORDING: RecordedAction[] = [
  { action: "click", locator: { by: "role", value: "button", name: "Delete" }, stepId: "cleanup-01" },
];

let cwd: string;

afterEach(async () => {
  delete process.env.CCQA_CLAUDE_MOCK_FILE;
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** Loads the fixture's one case through the same path `ccqa generate <case>` resolves. */
async function resolveFixtureCase(dir: string) {
  const config = await loadProjectConfig(dir);
  return resolveCase("docs/testcase/todo/add_item.md", config, dir);
}

/** A `GenerateContext` built the way `cli/generate.ts` builds one for an intent case. */
function contextFor(
  resolved: Awaited<ReturnType<typeof resolveFixtureCase>>,
  dir: string,
  resources: GenerateContext["resources"],
): GenerateContext {
  return {
    spec: { title: resolved.testCase.title, steps: [] },
    specYaml: "",
    featureName: "todo",
    specName: "add_item",
    cwd: dir,
    testPath: resolved.testPath,
    recording: RECORDING,
    cleanupRecording: CLEANUP_RECORDING,
    ref: resolved.testCase.ref,
    steps: resolved.testCase.steps,
    cleanup: resolved.testCase.cleanup,
    expectations: resolved.testCase.expectations,
    cleanupExpectations: resolved.testCase.cleanupExpectations,
    fields: resolved.testCase.fields,
    resources,
    conventions: resolved.targetConfig.conventions,
    targetConfig: resolved.targetConfig,
    language: "auto",
    hub: null,
    fix: { maxRetries: 0, mode: "auto", useSnapshot: false },
  };
}

async function mockClaude(dir: string, replyText: string): Promise<void> {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: replyText,
  });
  const mockPath = join(dir, "claude-mock.jsonl");
  await writeFile(mockPath, line + "\n", "utf8");
  process.env.CCQA_CLAUDE_MOCK_FILE = mockPath;
}

describe("external target — generation from a project's own config (mocked Claude)", () => {
  it("compiles the markdown case deterministically when the target has no resources to reuse", async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-external-target-")));
    await cp(FIXTURE_DIR, cwd, { recursive: true });

    const resolved = await resolveFixtureCase(cwd);
    // The spec-coverage review that follows every generation also goes
    // through Claude; a clean "nothing to report" answer keeps it out of the
    // way of the assertions below, which are about the compiled file.
    await mockClaude(cwd, JSON.stringify({ findings: [] }));

    // No resources: the deterministic mechanical draft ships as the file
    // verbatim (`generateExternalTest`'s finalizePreparedFiles path).
    const ctx = contextFor(resolved, cwd, []);
    const result = await resolved.target.generate(ctx);
    expect(result.passed).toBe(true);

    // 1. Lands at the configured testPath — {case} from the markdown's own path.
    expect(resolved.testPath).toBe("specs/todo/add_item.spec.ts");
    const generated = await readFile(resolve(cwd, resolved.testPath), "utf8");

    // 2. Header comment, filled in with the case's link URL.
    expect(generated).toContain("// case: todo/add_item");
    expect(generated).toContain("// source: https://example.test/sheet");

    // 3. Title ends with the tag the project's priority map assigns to "high".
    expect(generated).toContain('test("Adding an item puts it on the list @smoke"');

    // 4. ${CCQA_RUN_ID} is gone; the project's own runId expression is called
    // instead, assigned exactly once inside the test.
    expect(generated).not.toContain("CCQA_RUN_ID");
    expect(generated).toContain('import { generateRunId } from "../utils/run-id";');
    expect(generated.match(/uniqueValue = generateRunId\(\);/g)).toHaveLength(1);
    expect(generated).toContain("${uniqueValue}");

    // 5. Cleanup lands in an afterEach guarded by what the route created, and
    // that is recorded after the click that submitted it — not at the top of
    // the test, where an attempt that failed earlier would still clean up.
    expect(generated).toContain("test.afterEach(");
    expect(generated).toContain("if (!createdSomething) return;");
    expect(generated).toContain('name: "Delete"');
    const body = generated.split("\n").map((l) => l.trim());
    expect(body.indexOf("createdSomething = true;")).toBe(
      body.findIndex((l) => l.includes(`name: "Add"`)) + 1,
    );

    // 6. Step comments cite the markdown's own numbering and its own words, so
    // a reviewer reads the code against the case without opening both.
    expect(generated).toContain("// step 1: Open the todo list page");
    expect(generated).toContain("// step 2: Fill in the new item field with a unique title");
    expect(generated).toContain("// step 3: Click the add button");
    expect(generated).toContain("// step 4: Confirm the new item appears in the list");
    expect(generated).toContain("// cleanup 1: Delete the created item");
  });

  it("routes through the reuse-first rewrite when the target's resources are configured", async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "ccqa-external-target-")));
    await cp(FIXTURE_DIR, cwd, { recursive: true });

    const resolved = await resolveFixtureCase(cwd);

    // What the mocked Claude "generates": the draft rewritten to reuse the
    // project's own page object, exactly as the built-in playwright target's
    // reuse-first pass does (see reuse-first.test.ts).
    // The header, the title tag and every step-boundary capture survive the
    // rewrite: dropping one is what the generation gate rejects.
    const rewritten = `// case: todo/add_item
// source: https://example.test/sheet

import { test, expect } from "@playwright/test";
import { ccqaStepBefore, ccqaStepAfter } from "ccqa/step-evidence";
import { generateRunId } from "../../utils/run-id";
import { TodoListPage } from "../../pages/todo_list";

test.describe("Adding an item puts it on the list", () => {
  let uniqueValue: string | undefined;
  let createdSomething = false;

  test("Adding an item puts it on the list @smoke", async ({ page }) => {
    uniqueValue = generateRunId();
    const list = new TodoListPage(page);

    // step: step-01 [case]
    await ccqaStepBefore(page, "step-01", "case");
    await list.open("https://example.test/todo");
    await ccqaStepAfter(page, "step-01", "case");

    // step: step-02 [case]
    await ccqaStepBefore(page, "step-02", "case");
    await list.addItem(\`buy milk \${uniqueValue}\`);
    await ccqaStepAfter(page, "step-02", "case");

    // step: step-03 [case]
    await ccqaStepBefore(page, "step-03", "case");
    await page.getByRole("button", { name: "Add" }).click();
    createdSomething = true;
    await ccqaStepAfter(page, "step-03", "case");

    // step: step-04 [case]
    await ccqaStepBefore(page, "step-04", "case");
    await expect(page.getByText(\`buy milk \${uniqueValue}\`).first()).toBeVisible();
    await ccqaStepAfter(page, "step-04", "case");
  });

  test.afterEach(
    if (!createdSomething) return;

    // cleanup 1: Delete the created item
    await ccqaStepBefore(page, "cleanup-01", "cleanup");
    await page.getByRole("button", { name: "Delete" }).click();
    await ccqaStepAfter(page, "cleanup-01", "cleanup");
  });
});
`;
    await mockClaude(
      cwd,
      JSON.stringify({
        files: [{ path: resolved.testPath, contents: rewritten, kind: "test" }],
        summary: "reused TodoListPage instead of inlining the locator",
      }),
    );

    // Resources as the project actually configured them (non-empty): drives
    // generateExternalTest into the LLM engine rather than the deterministic path.
    const ctx = contextFor(resolved, cwd, resolved.targetConfig.resources);
    const result = await resolved.target.generate(ctx);
    expect(result.passed).toBe(true);

    const generated = await readFile(resolve(cwd, resolved.testPath), "utf8");
    expect(generated).toContain(`from "../../pages/todo_list"`);
  });
});
