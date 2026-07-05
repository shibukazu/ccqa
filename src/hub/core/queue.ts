import type { LearningJob } from "../contract/schema.ts";
import type { JobStore } from "./storage/types.ts";

export type LearningWorker = (job: LearningJob) => Promise<void>;

/**
 * A single-worker FIFO queue over the `JobStore`. Triage-learning jobs run one
 * at a time: each does a single Claude call (write a calibration note) and then
 * writes the analysis custom prompt, so serializing them keeps two learns for the
 * same project/profile from racing on the same custom prompt — and there is no reason
 * to parallelize a workload this light.
 *
 * State lives in `JobStore` (not just in memory) so a restart can recover:
 * `recoverFromRestart` sweeps any job left "running" and marks it "failed",
 * since its worker is gone and it will never finish.
 */
export class LearningQueue {
  private readonly jobs: JobStore;
  private readonly worker: LearningWorker;
  private readonly pending: string[] = [];
  private draining = false;
  private drainPromise: Promise<void> | null = null;

  constructor(jobs: JobStore, worker: LearningWorker) {
    this.jobs = jobs;
    this.worker = worker;
  }

  /**
   * Reconcile persisted jobs with this fresh process on startup:
   *   - "running": its worker died with the previous process and will never
   *     finish — mark it "failed".
   *   - "queued": persisted but never drained (the process died between the
   *     create write and its turn in the queue) — re-enqueue it so it runs.
   *     Without this a crash in that window orphans the job forever, and the
   *     UI polls it as "in progress" indefinitely.
   * Each job is handled independently so one unwritable/corrupt record can't
   * abort the sweep and leave every later stuck job unrecovered.
   */
  async recoverFromRestart(): Promise<void> {
    const jobs = await this.jobs.list({});
    for (const job of jobs) {
      if (job.status === "queued") {
        this.enqueue(job.id);
        continue;
      }
      if (job.status !== "running") continue;
      try {
        await this.jobs.update(job.id, {
          status: "failed",
          error: "hub restarted while this learning job was in progress",
          finishedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`hub: could not recover stuck learning job "${job.id}":`, err);
      }
    }
  }

  /** Enqueue a job that's already been persisted as "queued". Starts draining if idle. */
  enqueue(jobId: string): void {
    this.pending.push(jobId);
    if (!this.draining) {
      this.draining = true;
      // drain() handles per-job errors itself; this .catch is a backstop so a
      // fault in the loop machinery is logged, never an unhandled rejection
      // (enqueue is fire-and-forget — nothing awaits drainPromise in production).
      this.drainPromise = this.drain().catch((err) => {
        console.error("hub: learning queue drain crashed:", err);
      });
    }
  }

  /**
   * Resolves once every currently-enqueued job has finished processing. Tests
   * use this to avoid tearing down shared fixtures (e.g. deleting the
   * `JobStore`'s backing directory) while `drain()` is still mid-flight —
   * `enqueue` is otherwise fire-and-forget from the caller's perspective.
   */
  async waitIdle(): Promise<void> {
    await this.drainPromise;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const jobId = this.pending.shift()!;
        let job: LearningJob | null;
        try {
          job = await this.jobs.get(jobId);
        } catch (err) {
          // A corrupt job.json makes `get` throw. Skip it rather than let the
          // throw escape drain() and become an unhandled rejection that stalls
          // every later queued job.
          console.error(`hub: skipping unreadable learning job "${jobId}":`, err);
          continue;
        }
        // Skip anything no longer "queued" (already picked up, or gone).
        if (!job || job.status !== "queued") continue;
        await this.runOne(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(job: LearningJob): Promise<void> {
    try {
      const running = await this.jobs.update(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      // On success the worker itself writes status:"succeeded" + result (it
      // holds the payload; the queue doesn't). The queue only handles failure.
      await this.worker(running);
    } catch (err) {
      // The status write that records the failure can itself throw (the same
      // disk fault that failed the worker/"running" write). Guard it so a job
      // is never left stuck "running"/"queued" with the error silently lost —
      // at worst it stays stuck but the operator sees why in the logs.
      try {
        await this.jobs.update(job.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        });
      } catch (updateErr) {
        console.error(`hub: could not mark learning job "${job.id}" failed:`, updateErr, "(original error:", err, ")");
      }
    }
  }

  /** Number of jobs waiting to start (excludes the one currently running, if any). Surfaced via `GET /health`. */
  depth(): number {
    return this.pending.length;
  }
}
