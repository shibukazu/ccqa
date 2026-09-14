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

// Same shape as DRIFT_REPLY, plus the `locators` array a case carrying a
// listed locator must answer beside its verdict.
const DRIFT_REPLY_WITH_LOCATOR = JSON.stringify({
  drift: {
    label: "TEST_DRIFT",
    confidence: 0.9,
    surface: "generated",
    subDiagnosis: "SELECTOR_DRIFT",
    headline: "the navigation bar is addressed by a class the source no longer renders",
    recommendation: "re-record the case",
    reasoning: "the page object asks for .nav-bar-old; the source renders .nav-bar",
    evidence: [{ file: "pages/navigation_bar.ts:11", detail: "the class is nav-bar-old" }],
  },
  locators: [{ id: "L1", verdict: "drifted", note: "the source renders nav-bar, not nav-bar-old" }],
});

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

  // The reply is read fresh on every attempt — there is no cursor into the
  // file, so a rejected reply that should still look rejected on the retry
  // has to be written once per attempt rather than once for the whole test.
  // The shape the dump-inputs test below establishes: a page object reached
  // only through an import, so nothing in the test file itself names the
  // class the audit has to check.
  async function writeAddItemSpec(cwd: string): Promise<void> {
    await mkdir(join(cwd, "specs", "todo"), { recursive: true });
    await writeFile(
      join(cwd, "specs", "todo", "add_item.spec.ts"),
      [
        `import { NavigationBar } from "../../pages/navigation_bar";`,
        `test("Adding an item puts it on the list", async ({ page }) => {`,
        `  await new NavigationBar(page).openTodos();`,
        `});`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  // Rewritten inside the project copy, not the shared fixture: the product
  // still renders `.nav-bar`, so pointing the page object at `.nav-bar-old`
  // is what makes the locator scan report the class missing.
  async function useDriftedNavClass(cwd: string): Promise<void> {
    await writeFile(
      join(cwd, "pages", "navigation_bar.ts"),
      [
        `interface LocatorLike {`,
        `  click(): Promise<void>;`,
        `}`,
        `interface PageLike {`,
        `  locator(selector: string): LocatorLike;`,
        `}`,
        "",
        `export class NavigationBar {`,
        `  constructor(private readonly page: PageLike) {}`,
        "",
        `  async openTodos(): Promise<void> {`,
        `    await this.page.locator(".nav-bar-old").click();`,
        `  }`,
        `}`,
        "",
      ].join("\n"),
      "utf8",
    );
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

  // The dispute this answers: a class name a support file addresses produced no
  // finding, and from the outside "it never reached the audit" and "it did, and
  // nothing was said about it" look the same. The dump makes them different.
  //
  // What the mocked verdict cannot show is whether a real model would report
  // it; that is the prompt's contract, asserted in src/prompts/drift.test.ts.
  test("--dump-inputs shows the support file a class name lives in, and how it was reached", async () => {
    project = await setUp((product) => [product]);

    // A generated test that reaches the class only through a page object, the
    // shape that hid it: nothing in the test file itself names `.nav-bar`.
    await mkdir(join(project.cwd, "specs", "todo"), { recursive: true });
    await writeFile(
      join(project.cwd, "specs", "todo", "add_item.spec.ts"),
      [
        `import { NavigationBar } from "../../pages/navigation_bar";`,
        `test("Adding an item puts it on the list", async ({ page }) => {`,
        `  await new NavigationBar(page).openTodos();`,
        `});`,
        "",
      ].join("\n"),
      "utf8",
    );

    const mockPath = await mockClaude(project.cwd, NO_DRIFT);
    const result = await runCcqa(["audit", "--dump-inputs", "audit-inputs"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });
    expect(result.exitCode).toBe(0);

    const dump = await readFile(
      resolve(project.cwd, "audit-inputs", "todo", "add_item.md"),
      "utf8",
    );
    // The page object was handed over, and the dump says which import reached it.
    expect(dump).toContain("pages/navigation_bar.ts");
    expect(dump).toContain("specs/todo/add_item.spec.ts");
    // ...and its content is there, class name and all.
    expect(dump).toContain('.locator(".nav-bar")');
    // The product that renders the class is named as a root the audit may read.
    expect(dump).toContain(productDir!);
    // The scan's own inventory is written too, so "the class was never
    // checked" and "it was, and the product has it" read differently.
    expect(dump).toContain("Locators the scan looked up");
    expect(dump).toContain("| `nav-bar` | class |");
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

  // The control for the two tests below: the class the page object addresses
  // is the one the product renders, so the scan finds it and the reply owes
  // nothing beyond the ordinary "no drift".
  test("a class the product renders leaves nothing for the reply to answer", async () => {
    project = await setUp((product) => [product]);
    await writeAddItemSpec(project.cwd);

    const mockPath = await mockClaude(project.cwd, NO_DRIFT);
    const result = await runCcqa(["audit", "--report-format", "json"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      specs: Array<{ ok: boolean; drift: { label: string } | null }>;
    };
    expect(report.specs[0]!.ok).toBe(true);
    expect(report.specs[0]!.drift).toBeNull();
  });

  // The class the page object now addresses is not in the product at all, so
  // the scan hands it over as a locator the reply must answer for — and here
  // it does, with a diagnosis. That must survive to the report, not just the
  // retry machinery around it.
  test("a class the product no longer renders becomes a TEST_DRIFT the audit reports", async () => {
    project = await setUp((product) => [product]);
    await useDriftedNavClass(project.cwd);
    await writeAddItemSpec(project.cwd);

    const mockPath = await mockClaude(project.cwd, DRIFT_REPLY_WITH_LOCATOR);
    const result = await runCcqa(["audit", "--report-format", "json"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });

    // TEST_DRIFT names a repair, so it fails the gate.
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      specs: Array<{ drift: { label: string } | null }>;
    };
    expect(report.specs[0]!.drift?.label).toBe("TEST_DRIFT");
  });

  // Same missing class as above, but the reply never mentions it. Silence on
  // a listed locator is not a clean verdict — it is the one failure the list
  // exists to catch — so both attempts must be rejected and the case must
  // come out errored rather than quietly passed.
  test("a reply that ignores a listed locator is rejected", async () => {
    project = await setUp((product) => [product]);
    await useDriftedNavClass(project.cwd);
    await writeAddItemSpec(project.cwd);

    const mockPath = await mockClaude(project.cwd, NO_DRIFT);
    const result = await runCcqa(["audit", "--report-format", "json"], {
      cwd: project.cwd,
      env: { ...noColorEnv, CCQA_CLAUDE_MOCK_FILE: mockPath },
    });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as {
      specs: Array<{ ok: boolean; error?: string; drift: { label: string } | null }>;
    };
    expect(report.specs[0]!.ok).toBe(false);
    expect(report.specs[0]!.drift).toBeNull();
    expect(report.specs[0]!.error).toMatch(/L1|verdict/);
  });
});
