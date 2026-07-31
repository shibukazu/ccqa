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
    kind: "run",
    drift: null,
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
    const stored = await storage.prompts.get("demo", "triage.agent");
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
    await empty.jobs.create(makeJob());
    const worker = createLearningWorker({ storage: empty, invoke: vi.fn(), authCheck: () => ({ ok: true }) });
    await expect(worker(makeJob())).rejects.toThrow(/no graded triage cases/);
  });

  test("cases found but all under an unlearnable cause throws naming the count, and records casesExcluded", async () => {
    // Fresh storage: only an audit-only cause (NO_DRIFT) on a kind:"run" row,
    // so the learnable case count is 0 but the drop is not silent.
    const invalidOnly = createFileHubStorage(await mkdtemp(join(tmpdir(), "ccqa-learn-invalid-")));
    await invalidOnly.runs.create(makeRun("run-invalid", "demo"));
    await invalidOnly.triage.putActualCause("run-invalid", makeRecord({ actualCause: "NO_DRIFT" }));
    await invalidOnly.jobs.create(makeJob());

    const worker = createLearningWorker({ storage: invalidOnly, invoke: vi.fn(), authCheck: () => ({ ok: true }) });
    await expect(worker(makeJob())).rejects.toThrow(/1 graded triage case was recorded under a cause invalid for a run/);

    const job = await invalidOnly.jobs.get("job-1");
    expect(job?.input.casesConsidered).toBe(0);
    expect(job?.input.casesExcluded).toBe(1);
  });

  test("groups graded cases by target — one overlay per target, no-target feeds the fallback", async () => {
    // beforeEach already seeded run-1 with a no-target record (headline "button
    // not found"). Add one playwright and one agent-browser case.
    await storage.triage.putActualCause("run-1", makeRecord({
      feature: "checkout", spec: "pay", target: "playwright",
      predicted: { label: "TEST_DRIFT", confidence: 0.8, headline: "pw-headline" },
    }));
    await storage.triage.putActualCause("run-1", makeRecord({
      feature: "login", spec: "sso", target: "agent-browser",
      predicted: { label: "SPEC_CHANGE", confidence: 0.8, headline: "ab-headline" },
    }));

    const invoke = vi.fn(async () => okResult("learned note"));
    const worker = createLearningWorker({ storage, invoke, authCheck: () => ({ ok: true }) });
    await storage.jobs.create(makeJob());
    await worker(makeJob());

    // One Claude call per group: fallback + agent-browser + playwright.
    expect(invoke).toHaveBeenCalledTimes(3);

    const stored = await storage.prompts.get("demo", "triage.agent");
    const cp = AnalysisCustomPromptSchema.parse(JSON.parse(new TextDecoder().decode(stored!.blob)));
    // A per-target overlay for each target, versioned with the target name.
    expect(Object.keys(cp.byTarget ?? {}).sort()).toEqual(["agent-browser", "playwright"]);
    expect(cp.byTarget?.["playwright"]?.customPromptVersion).toContain("playwright");
    // The no-target case feeds the un-scoped fallback (top-level guidance).
    expect(cp.guidance).toBe("learned note");
    expect(cp.customPromptVersion).toContain("-c1"); // one no-target case

    // Isolation: the playwright group's prompt carries only its own case — no
    // agent-browser or fallback evidence leaks into another target's learning.
    const prompts = (invoke.mock.calls as unknown as Array<[{ prompt: string }]>).map((c) => c[0].prompt);
    const pwPrompt = prompts.find((p) => p.includes("pw-headline"));
    expect(pwPrompt).toBeDefined();
    expect(pwPrompt).not.toContain("ab-headline");
    expect(pwPrompt).not.toContain("button not found");
  });

  test("excludes a grade under a cause this row's kind cannot produce from its learning input", async () => {
    // NO_DRIFT is an audit-only grade — "nothing is wrong" is not an answer
    // about a run, where ENVIRONMENT says it instead.
    await storage.triage.putActualCause("run-1", makeRecord({
      feature: "checkout",
      spec: "invalid",
      predicted: { label: "PRODUCT_BUG", confidence: 0.6, headline: "excluded-headline" },
      actualCause: "NO_DRIFT",
    }));

    const invoke = vi.fn(async () => okResult("learned note"));
    const worker = createLearningWorker({ storage, invoke, authCheck: () => ({ ok: true }) });
    await storage.jobs.create(makeJob());
    await worker(makeJob());

    // Only the beforeEach-seeded PRODUCT_BUG case counts; the NO_DRIFT one is
    // a grade this row's kind cannot produce.
    const job = await storage.jobs.get("job-1");
    expect(job?.input.casesConsidered).toBe(1);
    expect(job?.input.casesExcluded).toBe(1);
    const prompts = (invoke.mock.calls as unknown as Array<[{ prompt: string }]>).map((c) => c[0].prompt);
    expect(prompts.some((p) => p.includes("excluded-headline"))).toBe(false);
  });
});
