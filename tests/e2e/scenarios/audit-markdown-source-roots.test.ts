import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { fixturePath, makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { noColorEnv } from "../_helpers/env.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";

// The case this covers is the one the audit could not reach before: a project
// whose tests are one checkout and whose application is another. Its cases are
// its own markdown, and the product it describes is under `sourceRoots`,
// outside the working directory entirely.
//
// Claude is mocked, so nothing here asserts the quality of a verdict. What it
// asserts is the wiring around one: that the markdown case is found and
// audited at all, that a root outside cwd resolves rather than being refused,
// that a root that is not there stops the sweep instead of quietly clearing
// it, and that `--brief` writes the finding out for whatever repairs the test.

const DRIFT_REPLY = JSON.stringify({
  drift: {
    label: "TEST_DRIFT",
    confidence: 0.9,
    surface: "generated",
    subDiagnosis: "SELECTOR_DRIFT",
    headline: "the add button is addressed by a label the source no longer renders",
    recommendation: "re-record the case",
    reasoning: "the source renders a button reading Add; the test asks for Create",
    evidence: [{ file: "src/todo-list.ts:22", detail: "the button's text is Add" }],
  },
});

const NO_DRIFT = '{"drift": null}';

describe("ccqa audit — markdown cases against a product outside the project", () => {
  let project: FakeProject | null = null;
  let productDir: string | null = null;

  afterEach(async () => {
    if (project) await project.cleanup();
    if (productDir) await rm(productDir, { recursive: true, force: true });
    project = null;
    productDir = null;
  });

  /**
   * The fixture project, plus the fictional product copied to a directory
   * beside it — deliberately not inside `cwd`, since containment is what this
   * feature exists to break. `roots` is given the product's path because it is
   * only known once the copy has happened.
   */
  async function setUp(roots: (product: string) => string[]): Promise<FakeProject> {
    productDir = await mkdtemp(join(tmpdir(), "ccqa-e2e-product-"));
    await cp(fixturePath("todo-product"), productDir, { recursive: true });

    const p = await makeFakeProject("external-target");
    const configPath = join(p.cwd, ".ccqa", "config.yaml");
    const config = await readFile(configPath, "utf8");
    const entries = roots(productDir).map((r) => `  - ${r}`).join("\n");
    await writeFile(configPath, `${config}\nsourceRoots:\n${entries}\n`, "utf8");
    return p;
  }

  async function mockClaude(cwd: string, reply: string): Promise<string> {
    const mockPath = join(cwd, "claude-mock.jsonl");
    await writeMockMessages(mockPath, [
      { type: "result", subtype: "success", result: reply, is_error: false },
    ]);
    return mockPath;
  }

  test("audits the markdown case, reads a root outside cwd, and writes a brief", async () => {
    project = await setUp((product) => [product]);

    // The generated test the audit reads as the case's second surface. Its
    // content does not matter to a mocked verdict; that it sits at the
    // target's `testPath` does.
    const testPath = join(project.cwd, "specs", "todo", "add_item.spec.ts");
    await mkdir(join(project.cwd, "specs", "todo"), { recursive: true });
    await writeFile(testPath, 'test("Adding an item puts it on the list", async () => {});\n', "utf8");

    const mockPath = await mockClaude(project.cwd, DRIFT_REPLY);
    const result = await runCcqa(["audit", "--report-format", "json", "--brief", "briefs"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });

    // TEST_DRIFT names a repair, so it fails the gate.
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      specs: Array<{ feature: string; spec: string; drift: { label: string } | null }>;
    };
    expect(report.specs).toHaveLength(1);
    expect(`${report.specs[0]!.feature}/${report.specs[0]!.spec}`).toBe("todo/add_item");
    expect(report.specs[0]!.drift?.label).toBe("TEST_DRIFT");

    const brief = JSON.parse(
      await readFile(resolve(project.cwd, "briefs", "todo", "add_item.json"), "utf8"),
    ) as { case: string; kind: string; test: string; repair: { route: string } };
    expect(brief.case).toBe("todo/add_item");
    expect(brief.kind).toBe("TEST_DRIFT");
    expect(brief.test).toBe("specs/todo/add_item.spec.ts");
    // Nothing recorded this case, so ccqa cannot claim it wrote the test: the
    // repair belongs to whoever owns the file.
    expect(brief.repair.route).toBe("external");
  });

  test("a sourceRoots entry that is not there stops the sweep", async () => {
    project = await setUp(() => ["../nowhere-at-all"]);
    const mockPath = await mockClaude(project.cwd, NO_DRIFT);

    const result = await runCcqa(["audit"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });

    expect(result.exitCode).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("nowhere-at-all");
  });
});
