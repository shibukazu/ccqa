import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LearningJob } from "../contract/schema.ts";
import { LearningQueue } from "./queue.ts";
import { createFileHubStorage } from "./storage/file/index.ts";
import type { JobStore } from "./storage/types.ts";

function makeJob(id: string, overrides: Partial<LearningJob> = {}): LearningJob {
  return {
    id,
    project: "demo",
    profile: "default",
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    input: { runLimit: 50, casesConsidered: 0 },
    result: null,
    ...overrides,
  };
}

describe("LearningQueue", () => {
  let dataDir: string;
  let jobs: JobStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-jobs-"));
    jobs = createFileHubStorage(dataDir).jobs;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("runs a queued job through running -> succeeded via the worker", async () => {
    await jobs.create(makeJob("job-1"));
    const worker = vi.fn(async (job: LearningJob) => {
      expect(job.status).toBe("running"); // queue flips status before calling
      await jobs.update(job.id, { status: "succeeded", finishedAt: new Date().toISOString() });
    });
    const queue = new LearningQueue(jobs, worker);

    queue.enqueue("job-1");
    await queue.waitIdle();

    expect((await jobs.get("job-1"))?.status).toBe("succeeded");
  });

  test("a throwing worker leaves the job failed with the error message", async () => {
    await jobs.create(makeJob("job-2"));
    const queue = new LearningQueue(
      jobs,
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );

    queue.enqueue("job-2");
    await queue.waitIdle();

    const job = await jobs.get("job-2");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("boom");
  });

  test("recoverFromRestart sweeps a stuck running job to failed", async () => {
    await jobs.create(makeJob("job-3", { status: "running", startedAt: new Date().toISOString() }));
    const queue = new LearningQueue(jobs, vi.fn());

    await queue.recoverFromRestart();

    const job = await jobs.get("job-3");
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/hub restarted/);
  });

  test("recoverFromRestart re-enqueues a job left queued (crashed before it drained)", async () => {
    // Persisted "queued" but never drained — the previous process died in the
    // create→drain window. Recovery must run it, not orphan it.
    await jobs.create(makeJob("job-q"));
    const worker = vi.fn(async (job: LearningJob) => {
      await jobs.update(job.id, { status: "succeeded", finishedAt: new Date().toISOString() });
    });
    const queue = new LearningQueue(jobs, worker);

    await queue.recoverFromRestart();
    await queue.waitIdle();

    expect(worker).toHaveBeenCalledOnce();
    expect((await jobs.get("job-q"))?.status).toBe("succeeded");
  });

  test("depth reflects jobs still waiting to start", async () => {
    await jobs.create(makeJob("job-4"));
    await jobs.create(makeJob("job-5"));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const queue = new LearningQueue(jobs, async (job) => {
      await gate; // hold the first job so the second stays pending
      await jobs.update(job.id, { status: "succeeded" });
    });

    queue.enqueue("job-4");
    queue.enqueue("job-5");
    expect(queue.depth()).toBe(1); // job-4 running, job-5 waiting

    release();
    await queue.waitIdle();
    expect(queue.depth()).toBe(0);
  });

  test("a failure-path status write that itself throws does not crash the drain loop", async () => {
    // A JobStore whose `update` throws on the "failed" write (e.g. disk fault):
    // the queue must swallow it (logged) and still finish draining the next job.
    const seen: string[] = [];
    const flaky = {
      create: async () => {},
      get: async (id: string) => makeJob(id),
      list: async () => [],
      update: async (id: string, patch: Partial<LearningJob>) => {
        if (patch.status === "failed") throw new Error("disk full");
        return makeJob(id, patch);
      },
    };
    const queue = new LearningQueue(flaky as never, async (job) => {
      seen.push(job.id);
      throw new Error("worker boom"); // forces the failure-path update
    });

    queue.enqueue("job-a");
    queue.enqueue("job-b");
    await expect(queue.waitIdle()).resolves.toBeUndefined(); // no unhandled rejection
    expect(seen).toEqual(["job-a", "job-b"]); // both jobs still processed
  });

  test("recoverFromRestart tolerates one un-updatable job and still sweeps the rest", async () => {
    await jobs.create(makeJob("ok-1", { status: "running", startedAt: new Date().toISOString() }));
    await jobs.create(makeJob("ok-2", { status: "running", startedAt: new Date().toISOString() }));
    // Wrap the real store so updating "ok-1" throws, mimicking a corrupt record.
    const guarded = Object.assign({}, jobs, {
      update: (id: string, patch: Parameters<typeof jobs.update>[1]) => {
        if (id === "ok-1") throw new Error("corrupt job.json");
        return jobs.update(id, patch);
      },
    });
    const queue = new LearningQueue(guarded as never, vi.fn());

    await queue.recoverFromRestart();

    expect((await jobs.get("ok-1"))?.status).toBe("running"); // couldn't fix it
    expect((await jobs.get("ok-2"))?.status).toBe("failed"); // but the sweep continued
  });
});
