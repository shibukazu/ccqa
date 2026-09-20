import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCcqa } from "../_helpers/cli.ts";
import { fixturePath, makeFakeProject, type FakeProject } from "../_helpers/fake-project.ts";
import { startTestHub, type TestHub } from "../_helpers/hub-server.ts";
import { noColorEnv, stripAnsi } from "../_helpers/env.ts";
import { writeMockMessages } from "../_helpers/fake-claude.ts";
import { DEFAULT_REPORT_DIR } from "../../../src/run/report-constants.ts";
import { RunReportDataSchema } from "../../../src/report/schema.ts";

/**
 * A project whose cases are its own documents, driven end to end.
 *
 * Its cases come from a reader module it owns (`ccqa/cases.mjs`), which is
 * the fixture's own copy of the one the docs show.
 *
 * Both of the failures covered here were silent: two call sites read
 * `.ccqa/features/**\/spec.yaml` directly instead of going through the case
 * reader, and a project that keeps no cases there got an empty answer that
 * looked like a legitimate one. The run reported every row with no title and
 * no step captions, and `ccqa perspectives` wrote no document at all — which
 * the hub answers with 404 for attestation, re-run and audit-need alike.
 */

const TOKEN = "test-token";
const PROJECT = "own-cases";

const CONFIG = `defaultTarget: e2e
targets:
  e2e:
    kind: external
    framework: playwright
    testPath: "specs/{case}.spec.ts"
    runCommand: "node scripts/fake-runner.mjs {files}"
    cases: ./ccqa/cases.mjs
`;

const CASE = `# Add a todo item

## Title

Adding an item puts it on the list

## Steps

1. Open the todo list
2. Fill in the new item field
3. Click the add button

## Expected

- The item appears at the top of the list

## Cleanup

1. Delete the created item
`;

/**
 * Stands in for the project's own test command. It writes one step-evidence
 * file per step so the report has captions to carry — the real runner reads
 * these frames back out of a Playwright trace.
 */
const FAKE_RUNNER = `import { writeFileSync } from "node:fs";
const dir = process.env.CCQA_EVIDENCE_DIR;
for (const stepId of ["step-01", "step-02", "step-03", "cleanup-01"]) {
  writeFileSync(\`\${dir}/\${stepId}.png\`, "png");
  writeFileSync(
    \`\${dir}/\${stepId}.json\`,
    JSON.stringify({ stepId, source: "case", pngFile: \`\${stepId}.png\`, url: null, title: null, capturedAt: null }),
  );
}
`;

async function writeProject(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".ccqa"), { recursive: true });
  await writeFile(join(cwd, ".ccqa/config.yaml"), CONFIG, "utf8");
  await mkdir(join(cwd, "ccqa"), { recursive: true });
  await cp(fixturePath("external-target/ccqa/cases.mjs"), join(cwd, "ccqa/cases.mjs"));
  await mkdir(join(cwd, "docs/testcase/todo/nested"), { recursive: true });
  await writeFile(join(cwd, "docs/testcase/todo/add_item.md"), CASE, "utf8");
  // Filed one level deeper, so its id splits into a feature name with a `/`
  // in it — the shape the hub's ledger keys and note edits have to survive.
  await writeFile(join(cwd, "docs/testcase/todo/nested/remove_item.md"), CASE, "utf8");
  await mkdir(join(cwd, "scripts"), { recursive: true });
  await writeFile(join(cwd, "scripts/fake-runner.mjs"), FAKE_RUNNER, "utf8");
  // The generated test the project's own command would run.
  await mkdir(join(cwd, "specs/todo/nested"), { recursive: true });
  await writeFile(join(cwd, "specs/todo/add_item.spec.ts"), "// generated\n", "utf8");
  await writeFile(join(cwd, "specs/todo/nested/remove_item.spec.ts"), "// generated\n", "utf8");
}

describe("a project whose cases are its own documents", () => {
  let project: FakeProject;

  beforeEach(async () => {
    project = await makeFakeProject("passing-spec", { linkCcqa: true });
    // The fixture's own `.ccqa/features` tree would hide the bug: the point is
    // a project that keeps no cases there at all.
    await rm(join(project.cwd, ".ccqa"), { recursive: true, force: true });
    await writeProject(project.cwd);
  });

  afterEach(async () => {
    await project.cleanup();
  });

  test("ccqa run names the case and captions its steps", async () => {
    const result = await runCcqa(["run", "todo/add_item"], {
      cwd: project.cwd,
      env: noColorEnv(),
      timeoutMs: 60_000,
    });
    expect(result.exitCode, stripAnsi(result.stdout + result.stderr)).toBe(0);

    const raw = await readFile(join(project.cwd, DEFAULT_REPORT_DIR, "report.json"), "utf8");
    const report = RunReportDataSchema.parse(JSON.parse(raw));
    const row = report.results.find((r) => r.spec === "add_item")!;
    expect(row.status).toBe("passed");
    // Read off the case, not off a `spec.yaml` this project does not have.
    expect(row.title).toBe("Adding an item puts it on the list");
    const captions = new Map((row.evidence ?? []).map((e) => [e.stepId, e.description]));
    expect(captions.get("step-01")).toBe("Open the todo list");
    // Cleanup is captioned too, and sorts after the case's own steps.
    expect((row.evidence ?? []).map((e) => e.stepId)).toEqual([
      "step-01",
      "step-02",
      "step-03",
      "cleanup-01",
    ]);
  }, 120_000);

  test("ccqa perspectives writes a document the hub can answer from", async () => {
    const hub: TestHub = await startTestHub({ token: TOKEN });
    try {
      const mockPath = join(project.cwd, "claude-mock.jsonl");
      await writeMockMessages(mockPath, [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: JSON.stringify({
            summaries: [
              { featureName: "todo", specName: "add_item", summary: "Adds an item." },
              { featureName: "todo/nested", specName: "remove_item", summary: "Removes it." },
            ],
          }),
        },
      ]);
      const result = await runCcqa(["perspectives", "--yes", "--project", PROJECT], {
        cwd: project.cwd,
        env: {
          ...noColorEnv(),
          CCQA_CLAUDE_MOCK_FILE: mockPath,
          CCQA_HUB_URL: hub.baseUrl,
          CCQA_HUB_TOKEN: TOKEN,
        },
        timeoutMs: 60_000,
      });
      expect(result.exitCode, stripAnsi(result.stdout + result.stderr)).toBe(0);

      const stored = await hub.storage.perspectives.get(PROJECT);
      expect(stored).not.toBeNull();
      const doc = JSON.parse(Buffer.from(stored!).toString("utf8")) as {
        features: Array<{ featureName: string; specs: Array<{ specName: string; title: string }> }>;
      };
      // A path-shaped case id splits into the feature/spec pair the hub still
      // spells a case by. A deeper id puts a `/` inside the feature name.
      expect(doc.features.map((f) => f.featureName)).toEqual(["todo", "todo/nested"]);
      expect(doc.features[0]!.specs[0]!.specName).toBe("add_item");
      expect(doc.features[0]!.specs[0]!.title).toBe("Adding an item puts it on the list");
      expect(doc.features[1]!.specs[0]!.specName).toBe("remove_item");

      // The one write path into the document, exercised against the nested
      // feature: the note edit carries feature and spec as body fields, so a
      // `/` inside the feature name has nothing to escape.
      const patch = await fetch(`${hub.baseUrl}/api/v1/projects/${PROJECT}/perspectives`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ feature: "todo/nested", spec: "remove_item", note: "checked" }),
      });
      expect(patch.status).toBe(204);
      const after = JSON.parse(
        Buffer.from((await hub.storage.perspectives.get(PROJECT))!).toString("utf8"),
      ) as { features: Array<{ featureName: string; specs: Array<{ note?: string }> }> };
      expect(after.features[1]!.specs[0]!.note).toBe("checked");
    } finally {
      await hub.close();
    }
  }, 120_000);

  test("--only-hub-rerun-needed reaches the hub instead of being refused", async () => {
    const hub: TestHub = await startTestHub({ token: TOKEN, encrypted: true });
    try {
      await hub.storage.perspectives.put(
        PROJECT,
        Buffer.from(
          JSON.stringify({
            features: [{ featureName: "todo", specs: [{ specName: "add_item" }] }],
          }),
        ),
      );
      const env = { ...noColorEnv(), CCQA_HUB_URL: hub.baseUrl, CCQA_HUB_TOKEN: TOKEN };
      const recorded = await runCcqa(
        ["hub", "deploy", "record", "--profile", "stg", "--sha", "a".repeat(40), "--project", PROJECT, "--no-select-specs"],
        { cwd: project.cwd, env, timeoutMs: 60_000 },
      );
      expect(recorded.exitCode, stripAnsi(recorded.stdout + recorded.stderr)).toBe(0);

      const result = await runCcqa(
        ["run", "--only-hub-rerun-needed", "--hub-profile", "stg", "--project", PROJECT],
        { cwd: project.cwd, env, timeoutMs: 60_000 },
      );
      const output = stripAnsi(result.stdout + result.stderr);
      // The flag used to be refused outright for these projects, because no
      // perspectives document could exist for them to be answered from. Now
      // the hub answers, and the run ends on the ordinary selection verdict
      // that any project gets when a deploy recorded no reach clears nothing.
      expect(output).not.toContain("has none of");
      expect(output).toContain("nothing was selected and no spec was cleared to run");
    } finally {
      await hub.close();
    }
  }, 120_000);
});
