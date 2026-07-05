import type { PromptStore } from "../types.ts";
import { listDirOrEmpty, listSubdirsOrEmpty, readBytesOrNull, readJson, removePath, writeBytes, writeJson } from "./fs-helpers.ts";
import { promptBlobPath, promptMetaPath, promptProjectDir, promptsKindDir } from "./paths.ts";

interface StoredMeta {
  meta: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Defense-in-depth path validation: the HTTP layer already checks project/name,
 * but this builds file paths from them, so it re-checks rather than trusting
 * callers. (Which names are allowed at all is the handler's job — this only
 * guards against path traversal.)
 */
function assertSafeName(value: string, label: string): void {
  if (value.length === 0 || value.includes("/") || value.includes("\\") || value.split(/[\\/]/).includes("..") || value === ".") {
    throw new Error(`invalid ${label}: must be a bare name without path separators or '..'`);
  }
}

/**
 * Prompt storage, project-scoped (not per-profile — prompts are project-wide).
 * The blob is plain UTF-8 text (Markdown or custom prompt JSON) with no encryption,
 * so this works whether or not `CCQA_HUB_ENCRYPTION_KEY` is configured.
 */
export function createFilePromptStore(root: string): PromptStore {
  return {
    async put(project, name, blob, meta = {}) {
      assertSafeName(project, "project");
      assertSafeName(name, "name");
      // Meta before blob: listings key off `.txt` files, so a crash between the
      // two writes leaves an invisible meta orphan, never a body without meta.
      await writeJson(promptMetaPath(root, project, name), {
        meta,
        updatedAt: new Date().toISOString(),
      } satisfies StoredMeta);
      await writeBytes(promptBlobPath(root, project, name), blob);
    },

    async get(project, name) {
      assertSafeName(project, "project");
      assertSafeName(name, "name");
      const blob = await readBytesOrNull(promptBlobPath(root, project, name));
      if (!blob) return null;
      const stored = await readJson<StoredMeta>(promptMetaPath(root, project, name));
      return { blob, meta: stored?.meta ?? {} };
    },

    async list(project) {
      assertSafeName(project, "project");
      const files = await listDirOrEmpty(promptProjectDir(root, project));
      const names = files
        .filter((f) => f.endsWith(".txt"))
        .map((f) => f.slice(0, -".txt".length));
      const out: { name: string; meta: Record<string, unknown>; updatedAt: string }[] = [];
      for (const name of names) {
        const stored = await readJson<StoredMeta>(promptMetaPath(root, project, name));
        out.push({ name, meta: stored?.meta ?? {}, updatedAt: stored?.updatedAt ?? "" });
      }
      return out;
    },

    async delete(project, name) {
      assertSafeName(project, "project");
      assertSafeName(name, "name");
      await removePath(promptBlobPath(root, project, name));
      await removePath(promptMetaPath(root, project, name));
    },

    async listProjects() {
      // `<root>/prompts/` holds one directory per project.
      return (await listSubdirsOrEmpty(promptsKindDir(root))).sort();
    },
  };
}
