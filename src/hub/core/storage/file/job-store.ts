import type { LearningJob } from "../../../contract/schema.ts";
import type { JobStore } from "../types.ts";
import { listSubdirsOrEmpty, readJson, updateJson, writeJson } from "./fs-helpers.ts";
import { jobMetaPath, jobsDir } from "./paths.ts";

/**
 * Read one job record for a list scan, tolerating a bad entry: a missing
 * job.json returns null silently, a corrupt one is logged and skipped — one
 * damaged record must not 500 the whole jobs list.
 */
async function readJobOrSkip(root: string, id: string): Promise<LearningJob | null> {
  try {
    return await readJson<LearningJob>(jobMetaPath(root, id));
  } catch (err) {
    console.error(`hub: skipping unreadable job "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function createFileJobStore(root: string): JobStore {
  return {
    async create(job) {
      await writeJson(jobMetaPath(root, job.id), job);
    },

    async get(id) {
      return await readJson<LearningJob>(jobMetaPath(root, id));
    },

    async update(id, patch) {
      return await updateJson<LearningJob>(jobMetaPath(root, id), (current) => {
        if (!current) throw new Error(`job "${id}" not found`);
        return { ...current, ...patch };
      });
    },

    async list({ project, profile, limit }) {
      const ids = await listSubdirsOrEmpty(jobsDir(root));
      const jobs: LearningJob[] = [];
      for (const id of ids) {
        const job = await readJobOrSkip(root, id);
        if (!job) continue;
        if (project !== undefined && job.project !== project) continue;
        if (profile !== undefined && job.profile !== profile) continue;
        jobs.push(job);
      }
      jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return limit ? jobs.slice(0, limit) : jobs;
    },
  };
}
