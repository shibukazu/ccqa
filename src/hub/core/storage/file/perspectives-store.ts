import type { PerspectivesStore } from "../types.ts";
import { assertSafeName, readBytesOrNull, removePath, updateJson, writeBytes } from "./fs-helpers.ts";
import { perspectivesPath } from "./paths.ts";

/**
 * Perspectives storage: one JSON document per project, plain UTF-8 with no
 * encryption (an inventory of what is tested is not a secret). No meta file —
 * the document's own `generatedAt` is its timestamp.
 */
export function createFilePerspectivesStore(root: string): PerspectivesStore {
  return {
    async put(project, blob) {
      assertSafeName(project, "project");
      await writeBytes(perspectivesPath(root, project), blob);
    },

    async get(project) {
      assertSafeName(project, "project");
      return readBytesOrNull(perspectivesPath(root, project));
    },

    async update(project, mutate) {
      assertSafeName(project, "project");
      await updateJson<unknown>(perspectivesPath(root, project), mutate);
    },

    async delete(project) {
      assertSafeName(project, "project");
      await removePath(perspectivesPath(root, project));
    },
  };
}
