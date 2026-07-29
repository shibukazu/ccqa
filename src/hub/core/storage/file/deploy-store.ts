import type { DeployLog, SpecTouchIndex } from "../../../contract/schema.ts";
import { appendDeploy, emptyDeployLog } from "../../deploy-log.ts";
import type { DeployStore } from "../types.ts";
import { readJson, updateJson } from "./fs-helpers.ts";
import { deployLogPath, deployTouchIndexPath } from "./paths.ts";

export function createFileDeployStore(root: string): DeployStore {
  const readLog = async (project: string, profile: string): Promise<DeployLog> =>
    (await readJson<DeployLog>(deployLogPath(root, project, profile))) ?? emptyDeployLog();

  return {
    async append(project, profile, input) {
      // Position assignment and the chaining check both read the head, so they
      // have to happen inside the same critical section as the write —
      // otherwise two concurrent deploys could claim the same index.
      const log = await updateJson<DeployLog>(deployLogPath(root, project, profile), (current) =>
        appendDeploy(current, input),
      );
      return log.entries[log.entries.length - 1]!;
    },

    async confirmSelection(project, profile, index) {
      await updateJson<DeployLog>(deployLogPath(root, project, profile), (current) => {
        const log = current ?? emptyDeployLog();
        return {
          ...log,
          entries: log.entries.map((e) => (e.index === index ? { ...e, hasSelection: true } : e)),
        };
      });
    },

    getLog: readLog,

    async head(project, profile) {
      const { entries } = await readLog(project, profile);
      return entries[entries.length - 1] ?? null;
    },

    async getTouchIndex(project, profile) {
      return (await readJson<SpecTouchIndex>(deployTouchIndexPath(root, project, profile))) ?? {};
    },

    async updateTouchIndex(project, profile, mutate) {
      await updateJson<SpecTouchIndex>(deployTouchIndexPath(root, project, profile), (current) =>
        mutate(current ?? {}),
      );
    },
  };
}
