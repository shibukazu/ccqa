import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeMockMessages } from "../../tests/e2e/_helpers/fake-claude.ts";
import { DRIFT_PROMPT_VERSION } from "../../src/prompts/drift.ts";
import { runAuditEval } from "./audit-eval.ts";
import { listFixtureSpecKeys } from "./cases.ts";
import { DEFAULT_APP_DIR } from "./results.ts";
import { runSelectEval } from "./select-eval.ts";

// One case end to end through the real CLI, with the Claude SDK replaced by
// the JSONL replay (CCQA_CLAUDE_MOCK_FILE) — repo build, mutation, sweep,
// scoring, result file — so CI proves the wiring without an API key. The
// mock replays the same reply for every invocation, which makes the expected
// numbers exact.
//
// The cases are written here, not read from the committed set: the wiring
// under test is the harness, and pinning it to committed cases would break
// this suite every time the case set is rebuilt. Only the mutations lean on
// the committed baseline app, so a baseline edit that invalidates one fails
// loudly (see `applyMutations`).

/**
 * The whole fixture spec tree, sorted — derived, so the expected counts track
 * the tree. The spec names inside `CASES` below stay literal on purpose: they
 * are this suite's own ground truth, not a mirror of the tree.
 */
let ALL_SPECS: string[];

beforeAll(async () => {
  ALL_SPECS = await listFixtureSpecKeys(DEFAULT_APP_DIR);
});

const CASES: Record<string, string> = {
  "wiring-baseline-clean": `
title: nothing changes at all
mutations: []
expect:
  audit: {}
`,
  "wiring-rename-add-button": `
title: visible button label renamed
mutations:
  - file: web/src/pages/ProjectDetailPage.tsx
    search: '<Button type="submit">Add task</Button>'
    replace: '<Button type="submit">Add to list</Button>'
expect:
  audit:
    tasks/add-task:
      label: TEST_DRIFT
      surface: generated
      subDiagnosis: SELECTOR_DRIFT
`,
  "wiring-api-shared-change": `
title: the shared fetch layer changes
mutations:
  - file: web/src/api/http.ts
    search: 'credentials: "same-origin",'
    replace: 'credentials: "include",'
expect:
  select:
    auth/login: needed
    tasks/add-task: needed
    tasks/complete-task: needed
    tasks/filter-tasks: needed
`,
  "wiring-block-spec-file-change": `
title: the login block's spec file changes (mechanical)
mutations:
  - file: .ccqa/blocks/login/spec.yaml
    search: 'title: sign in with the seeded account'
    replace: 'title: sign in with the seeded team account'
expect:
  select:
    auth/login: needed
    auth/logout: needed
    projects/create-project: needed
    projects/open-project: needed
    settings/update-profile: needed
    tasks/add-task: needed
    tasks/complete-task: needed
    tasks/edit-task-notes: needed
    tasks/filter-tasks: needed
`,
};

describe("eval wiring (mocked Claude)", () => {
  let dir: string;
  let casesDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-eval-wiring-"));
    casesDir = join(dir, "cases");
    await mkdir(casesDir);
    for (const [name, yaml] of Object.entries(CASES)) {
      await writeFile(join(casesDir, `${name}.yaml`), yaml.trimStart(), "utf8");
    }
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("audit: an all-clean reply scores 10/10 on the clean baseline", async () => {
    const mock = join(dir, "mock.jsonl");
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: '{"drift": null}', is_error: false },
    ]);
    const summary = await runAuditEval({
      filter: "wiring-baseline-clean",
      casesDir,
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    expect(summary.cases).toHaveLength(1);
    expect(summary.confusion.total).toBe(ALL_SPECS.length);
    expect(summary.confusion.correct).toBe(ALL_SPECS.length);
    expect(summary.confusion.matrix.CLEAN.CLEAN).toBe(ALL_SPECS.length);
    expect(summary.meta.promptVersion).toBe(DRIFT_PROMPT_VERSION);
    // Mock runs bill nothing but still count as invocations.
    expect(summary.meta.cost?.invocations).toBe(1);

    const written = JSON.parse(await readFile(summary.resultPath, "utf8"));
    expect(written.model).toBe("haiku");
    expect(written.confusion.total).toBe(ALL_SPECS.length);
  }, 120_000);

  it("audit: a drift-everywhere reply lands in the false-positive cells", async () => {
    const mock = join(dir, "mock.jsonl");
    const drift = {
      drift: {
        label: "TEST_DRIFT",
        confidence: 0.9,
        surface: "generated",
        subDiagnosis: "SELECTOR_DRIFT",
        headline: "mocked finding",
        evidence: [],
      },
    };
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: JSON.stringify(drift), is_error: false },
    ]);
    const summary = await runAuditEval({
      filter: "wiring-rename-add-button",
      casesDir,
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    // The mutated spec matches; the nine bystanders are cried-wolf misses.
    expect(summary.confusion.matrix.TEST_DRIFT.TEST_DRIFT).toBe(1);
    expect(summary.confusion.matrix.CLEAN.TEST_DRIFT).toBe(ALL_SPECS.length - 1);
    expect(summary.confusion.correct).toBe(1);
    const mutated = summary.cases[0]!.outcomes.find((o) => o.spec === "tasks/add-task")!;
    expect(mutated.subAnswers).toEqual([
      { field: "surface", expected: "generated", got: "generated", match: true },
      { field: "subDiagnosis", expected: "SELECTOR_DRIFT", got: "SELECTOR_DRIFT", match: true },
    ]);
  }, 120_000);

  it("select: a full verdict reply scores precision and recall", async () => {
    const mock = join(dir, "mock.jsonl");
    const needed = new Set(["auth/login", "tasks/add-task", "tasks/complete-task"]);
    const reply = {
      specs: ALL_SPECS.map((spec) =>
        needed.has(spec)
          ? { spec, verdict: "needed", reason: "shared fetch layer", touchedBy: ["web/src/api/http.ts"] }
          : { spec, verdict: "notNeeded", reason: "checked: does not go through the changed layer" },
      ),
    };
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: JSON.stringify(reply), is_error: false },
    ]);
    const summary = await runSelectEval({
      filter: "wiring-api-shared-change",
      casesDir,
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    expect(summary.cases).toHaveLength(1);
    // Four specs are expected needed; the mock concedes three of them.
    expect(summary.metrics.truePositives).toBe(3);
    expect(summary.metrics.falseNegatives).toBe(1);
    expect(summary.metrics.precision).toBe(1);
    expect(summary.metrics.recall).toBeCloseTo(3 / 4);
    expect(summary.meta.promptVersion).toBeNull();
  }, 120_000);

  it("select: a spec-tree-only change is answered without consulting the model", async () => {
    const mock = join(dir, "mock.jsonl");
    // A reply that would ruin the score if it were ever consulted: every spec
    // omitted, so a model-sourced answer would come back all-unknown. The
    // mechanical path must decide the case before the model is reached.
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: '{"specs": []}', is_error: false },
    ]);
    const summary = await runSelectEval({
      filter: "wiring-block-spec-file-change",
      casesDir,
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    // Perfect exact verdicts with zero unknowns: had the poisoned mock been
    // consulted, every spec would have come back `unknown`. (The cost file
    // still records the command invocation — it counts commands, not calls.)
    expect(summary.metrics.verdictAccuracy).toBe(1);
    expect(summary.metrics.recall).toBe(1);
    expect(summary.metrics.precision).toBe(1);
    expect(summary.metrics.unknowns).toBe(0);
  }, 120_000);
});
