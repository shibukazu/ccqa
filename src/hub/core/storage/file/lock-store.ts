import { SpecLocksSchema, type SpecLocks } from "../../../contract/schema.ts";
import { emptyLocks } from "../../locks.ts";
import type { LockStore } from "../types.ts";
import { readJson, updateJson } from "./fs-helpers.ts";
import { specLocksPath } from "./paths.ts";

function toLocks(doc: unknown): SpecLocks {
  const parsed = SpecLocksSchema.safeParse(doc);
  return parsed.success ? parsed.data : emptyLocks();
}

export function createFileLockStore(root: string): LockStore {
  return {
    async get(project, profile) {
      return toLocks(await readJson<unknown>(specLocksPath(root, project, profile)));
    },

    async update(project, profile, mutate) {
      // The whole read-modify-write stays inside one `updateJson` critical
      // section: two jobs asking at once must not both read "free" and both
      // write themselves in.
      return updateJson<SpecLocks>(specLocksPath(root, project, profile), (current) =>
        mutate(toLocks(current)),
      );
    },
  };
}
