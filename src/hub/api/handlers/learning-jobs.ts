import { randomUUID } from "node:crypto";
import { CreateLearningJobRequestSchema, type LearningJob } from "../../contract/schema.ts";
import type { LearningQueue } from "../../core/queue.ts";
import type { HubStorage } from "../../core/storage/types.ts";
import type { RouteContext } from "../router.ts";
import { HttpError, readBody, sendJson } from "../respond.ts";
import { requireSafeSegment } from "../validate.ts";

const MAX_BODY_BYTES = 4 * 1024;

export interface LearningJobHandlerConfig {
  storage: HubStorage;
  queue: LearningQueue;
}

/** POST /api/v1/projects/:project/learning-jobs — create + enqueue a triage-learning job. */
export function createCreateLearningJobHandler(config: LearningJobHandlerConfig) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const body = await readBody(ctx.req, MAX_BODY_BYTES);
    const parsed = CreateLearningJobRequestSchema.safeParse(JSON.parse(body.toString("utf8") || "{}"));
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", parsed.error.issues[0]?.message ?? "invalid learning job body");
    }
    const profile = requireSafeSegment(parsed.data.profile, "profile");

    const job: LearningJob = {
      id: randomUUID(),
      project,
      profile,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      input: {
        runLimit: parsed.data.runLimit ?? 50,
        casesConsidered: 0,
      },
      result: null,
    };

    // Persist before enqueueing so the queue's `get` always finds the record —
    // avoids the create/enqueue race where drain runs before the write lands.
    await config.storage.jobs.create(job);
    config.queue.enqueue(job.id);
    sendJson(ctx.res, 202, job);
  };
}

/** GET /api/v1/projects/:project/learning-jobs — newest first, no before/after bodies. */
export function createListLearningJobsHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const profile = ctx.url.searchParams.get("profile") ?? undefined;
    const jobs = await storage.jobs.list({ project, ...(profile ? { profile } : {}) });
    // Strip the (potentially large) before/after prompt strings from the list;
    // the detail endpoint carries them.
    sendJson(ctx.res, 200, {
      jobs: jobs.map(({ result, ...rest }) => ({
        ...rest,
        customPromptVersion: result?.customPromptVersion ?? null,
      })),
    });
  };
}

/** GET /api/v1/projects/:project/learning-jobs/:jobId — the full record incl. before/after prompts. */
export function createGetLearningJobHandler(storage: HubStorage) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = requireSafeSegment(ctx.params.project!, "project");
    const jobId = requireSafeSegment(ctx.params.jobId!, "jobId");
    const job = await storage.jobs.get(jobId);
    if (!job || job.project !== project) {
      throw new HttpError(404, "not_found", `learning job "${jobId}" not found for project "${project}"`);
    }
    sendJson(ctx.res, 200, job);
  };
}
