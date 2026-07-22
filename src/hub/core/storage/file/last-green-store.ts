import type { LastGreenEntry } from "../../../contract/schema.ts";
import type { LastGreenStore } from "../types.ts";
import { readJson, updateJson } from "./fs-helpers.ts";
import { lastGreenPath } from "./paths.ts";

export function createFileLastGreenStore(root: string): LastGreenStore {
  return {
    async get(project, profile, branch) {
      return (
        (await readJson<Record<string, LastGreenEntry>>(lastGreenPath(root, project, profile, branch))) ?? {}
      );
    },

    async merge(project, profile, branch, entries) {
      await updateJson<Record<string, LastGreenEntry>>(
        lastGreenPath(root, project, profile, branch),
        (current) => {
          const out = { ...(current ?? {}) };
          for (const [key, entry] of Object.entries(entries)) {
            const prev = out[key];
            // Only advance: a late-finalizing older run must not move a
            // spec's baseline backwards past a newer green.
            if (!prev || prev.at <= entry.at) out[key] = entry;
          }
          return out;
        },
      );
    },
  };
}
