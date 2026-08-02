import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMockMessages } from "../../tests/e2e/_helpers/fake-claude.ts";
import { DRIFT_PROMPT_VERSION } from "../../src/prompts/drift.ts";
import { runAuditEval } from "./audit-eval.ts";
import { runSelectEval } from "./select-eval.ts";

// One case end to end through the real CLI, with the Claude SDK replaced by
// the JSONL replay (CCQA_CLAUDE_MOCK_FILE) — repo build, mutation, sweep,
// scoring, result file — so CI proves the wiring without an API key. The
// mock replays the same reply for every invocation, which makes the expected
// numbers exact.

describe("eval wiring (mocked Claude)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-eval-wiring-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("audit: an all-clean reply scores 4/4 on the clean baseline", async () => {
    const mock = join(dir, "mock.jsonl");
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: '{"drift": null}', is_error: false },
    ]);
    const summary = await runAuditEval({
      filter: "baseline-clean",
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    expect(summary.cases).toHaveLength(1);
    expect(summary.confusion.total).toBe(4);
    expect(summary.confusion.correct).toBe(4);
    expect(summary.confusion.matrix.CLEAN.CLEAN).toBe(4);
    expect(summary.meta.promptVersion).toBe(DRIFT_PROMPT_VERSION);
    // Mock runs bill nothing but still count as invocations.
    expect(summary.meta.cost?.invocations).toBe(1);

    const written = JSON.parse(await readFile(summary.resultPath, "utf8"));
    expect(written.model).toBe("haiku");
    expect(written.confusion.total).toBe(4);
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
      filter: "rename-add-button",
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    // The mutated spec matches; the three bystanders are cried-wolf misses.
    expect(summary.confusion.matrix.TEST_DRIFT.TEST_DRIFT).toBe(1);
    expect(summary.confusion.matrix.CLEAN.TEST_DRIFT).toBe(3);
    expect(summary.confusion.correct).toBe(1);
    const mutated = summary.cases[0]!.outcomes.find((o) => o.spec === "tasks/add-task")!;
    expect(mutated.subAnswers).toEqual([
      { field: "surface", expected: "generated", got: "generated", match: true },
      { field: "subDiagnosis", expected: "SELECTOR_DRIFT", got: "SELECTOR_DRIFT", match: true },
    ]);
  }, 120_000);

  it("select: a full verdict reply scores precision and recall", async () => {
    const mock = join(dir, "mock.jsonl");
    const reply = {
      specs: [
        { spec: "auth/login", verdict: "needed", reason: "shared fetch layer", touchedBy: ["public/js/api.js"] },
        { spec: "tasks/add-task", verdict: "needed", reason: "shared fetch layer", touchedBy: ["public/js/api.js"] },
        { spec: "tasks/complete-task", verdict: "needed", reason: "shared fetch layer", touchedBy: ["public/js/api.js"] },
        { spec: "tasks/filter-tasks", verdict: "notNeeded", reason: "checked: filter flow does not fetch" },
      ],
    };
    await writeMockMessages(mock, [
      { type: "result", subtype: "success", result: JSON.stringify(reply), is_error: false },
    ]);
    const summary = await runSelectEval({
      filter: "api-shared-change",
      resultsDir: join(dir, "results"),
      env: { CCQA_CLAUDE_MOCK_FILE: mock },
      quiet: true,
    });
    expect(summary.cases).toHaveLength(1);
    expect(summary.metrics.truePositives).toBe(3);
    expect(summary.metrics.falseNegatives).toBe(1);
    expect(summary.metrics.precision).toBe(1);
    expect(summary.metrics.recall).toBeCloseTo(3 / 4);
    expect(summary.meta.promptVersion).toBeNull();
  }, 120_000);
});
