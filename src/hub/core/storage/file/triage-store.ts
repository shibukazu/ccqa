import type { TriageRecord, TriageStore } from "../types.ts";
import { readJson, removePath, serialize, updateJson } from "./fs-helpers.ts";
import { triagePath } from "./paths.ts";

export function createFileTriageStore(root: string): TriageStore {
  return {
    async putActualCause(runId, record) {
      const path = triagePath(root, runId);
      await updateJson<TriageRecord[]>(path, (current) => {
        const records = current ?? [];
        const idx = records.findIndex((r) => r.feature === record.feature && r.spec === record.spec);
        if (idx === -1) records.push(record);
        else records[idx] = record;
        return records;
      });
    },

    async deleteActualCause(runId, feature, spec) {
      const path = triagePath(root, runId);
      await updateJson<TriageRecord[]>(path, (current) => {
        const records = current ?? [];
        return records.filter((r) => !(r.feature === feature && r.spec === spec));
      });
    },

    async deleteAll(runId) {
      const path = triagePath(root, runId);
      await serialize(path, () => removePath(path));
    },

    async list(runId) {
      return (await readJson<TriageRecord[]>(triagePath(root, runId))) ?? [];
    },
  };
}
