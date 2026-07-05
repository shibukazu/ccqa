import type { Run } from "../../../contract/schema.ts";
import type { RunStore } from "../types.ts";
import { listSubdirsOrEmpty, readJson, writeJson } from "./fs-helpers.ts";
import { runMetaPath, runsDir } from "./paths.ts";

/**
 * Read one run record for an aggregate scan, tolerating a bad entry: a
 * missing run.json (push raced) returns null silently, while a corrupt one is
 * logged and skipped — one damaged record must not 500 every list/aggregate
 * endpoint.
 */
async function readRunOrSkip(root: string, id: string): Promise<Run | null> {
  try {
    return await readJson<Run>(runMetaPath(root, id));
  } catch (err) {
    console.error(`hub: skipping unreadable run "${id}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function createFileRunStore(root: string): RunStore {
  return {
    async create(run) {
      await writeJson(runMetaPath(root, run.id), run);
    },

    async get(id) {
      return await readJson<Run>(runMetaPath(root, id));
    },

    async list({ project, branch, status, limit }) {
      const ids = await listSubdirsOrEmpty(runsDir(root));
      const runs: Run[] = [];
      for (const id of ids) {
        const run = await readRunOrSkip(root, id);
        if (!run) continue;
        if (project !== undefined && run.project !== project) continue;
        if (branch !== undefined && run.branch !== branch) continue;
        if (status !== undefined && run.status !== status) continue;
        runs.push(run);
      }
      runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return limit ? runs.slice(0, limit) : runs;
    },

    async listProjects() {
      const ids = await listSubdirsOrEmpty(runsDir(root));
      const projects = new Set<string>();
      for (const id of ids) {
        const run = await readRunOrSkip(root, id);
        if (run) projects.add(run.project);
      }
      return [...projects].sort();
    },
  };
}
