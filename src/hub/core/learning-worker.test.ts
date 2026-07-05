import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InvokeClaudeStreamingResult } from "../../claude/invoke.ts";
import { AnalysisCustomPromptSchema } from "../../prompts/custom-prompt.ts";
import type { LearningJob, Run } from "../contract/schema.ts";
import { createLearningWorker } from "./learning-worker.ts";
import { createFileHubStorage } from "./storage/file/index.ts";
import type { HubStorage, TriageRecord } from "./storage/types.ts";

function makeRun(id: string, project: string): Run {
  return {
    id,
    project,
    profile: null,
    branch: null,
    status: "failed",
    specs: { total: 1, passed: 0, failed: 1 },
    gitHead: null,
    promptVersion: "4",
    ciRunId: null,
    reportCreatedAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeRecord(overrides: Partial<TriageRecord> = {}): TriageRecord {
  return {
    feature: "login",
    spec: "happy",
    predicted: { label: "TEST_DRIFT", confidence: 0.8, headline: "button not found" },
    actualCause: "PRODUCT_BUG",
    promptVersion: "4",
    recordedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<LearningJob> = {}): LearningJob {
  return {
    id: "job-1",
    project: "demo",
    profile: "default",
    status: "running",
    createdAt: "2026-07-03T00:00:00.000Z",
    startedAt: "2026-07-03T00:00:01.000Z",
    finishedAt: null,
    error: null,
    input: { runLimit: 50, casesConsidered: 0 },
    result: null,
    ...overrides,
  };
}

const okResult = (result: string): InvokeClaudeStreamingResult => ({
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
});

describe("createLearningWorker", () => {
  let dataDir: string;
  let storage: HubStorage;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-learn-worker-"));
    storage = createFileHubStorage(dataDir);
    await storage.runs.create(makeRun("run-1", "demo"));
    await storage.triage.putActualCause("run-1", makeRecord());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("learning calls Claude and stores the calibration note", async () => {
    const invoke = vi.fn(async () => okResult("Prefer PRODUCT_BUG when the DOM is intact."));
    const worker = createLearningWorker({ storage, invoke, authCheck: () => ({ ok: true }) });
    await storage.jobs.create(makeJob());

    await worker(makeJob());

    expect(invoke).toHaveBeenCalledOnce();
    const job = await storage.jobs.get("job-1");
    expect(job?.status).toBe("succeeded");
    expect(job?.input.casesConsidered).toBe(1);
    const stored = await storage.prompts.get("demo", "analysis-custom-prompt");
    const customPrompt = AnalysisCustomPromptSchema.parse(JSON.parse(new TextDecoder().decode(stored!.blob)));
    expect(customPrompt.guidance).toContain("Prefer PRODUCT_BUG");
    // before = base-only (no prior custom prompt); after includes the guidance block.
    expect(job?.result?.beforePrompt).not.toContain("Calibration guidance");
    expect(job?.result?.afterPrompt).toContain("Calibration guidance");
  });

  test("learning without Claude auth throws (caught by the queue as a failed job)", async () => {
    const worker = createLearningWorker({
      storage,
      invoke: vi.fn(),
      authCheck: () => ({ ok: false, reason: "no ANTHROPIC_API_KEY / claude login" }),
    });
    await expect(worker(makeJob())).rejects.toThrow(/needs Claude auth/);
  });

  test("learning that returns nothing usable throws", async () => {
    const worker = createLearningWorker({
      storage,
      invoke: vi.fn(async () => okResult("   ")),
      authCheck: () => ({ ok: true }),
    });
    const job = makeJob();
    await storage.jobs.create(job);
    await expect(worker(job)).rejects.toThrow(/no usable calibration note/);
    // The case count was recorded before the Claude call failed, so the UI
    // shows the real number rather than the create-time 0.
    expect((await storage.jobs.get(job.id))?.input.casesConsidered).toBe(1);
  });

  test("no graded cases throws with a clear reason", async () => {
    const empty = createFileHubStorage(await mkdtemp(join(tmpdir(), "ccqa-learn-empty-")));
    const worker = createLearningWorker({ storage: empty, invoke: vi.fn(), authCheck: () => ({ ok: true }) });
    await expect(worker(makeJob())).rejects.toThrow(/no graded triage cases/);
  });
});
