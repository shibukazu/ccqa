import { join } from "node:path";
import type { SourceMapStore } from "../types.ts";
import { assertSafeName, listSubdirsOrEmpty, listFilesRecursive, readBytesOrNull, readJson, removePath, writeBytes, writeJson } from "./fs-helpers.ts";
import { sourceMapCommitDir, sourceMapProjectDir } from "./paths.ts";

/**
 * Defense-in-depth: the HTTP layer validates the asset path before it gets
 * here, but this store joins it onto a directory, so it re-checks rather than
 * trusting the caller.
 */
function assertSafeAssetPath(assetPath: string): void {
  const segments = assetPath.split("/");
  if (
    assetPath.length === 0 ||
    assetPath.startsWith("/") ||
    assetPath.includes("\\") ||
    segments.includes("..") ||
    segments.includes(".")
  ) {
    throw new Error("invalid source map path: must be relative, without '.' or '..' segments");
  }
}

/** Marks when a commit last received a push; see `listCommits`. */
const PUSHED_AT = "pushed-at.json";

export function createFileSourceMapStore(root: string): SourceMapStore {
  return {
    async put(project, commit, assetPath, bytes) {
      assertSafeName(project, "project");
      assertSafeName(commit, "commit");
      assertSafeAssetPath(assetPath);
      const dir = sourceMapCommitDir(root, project, commit);
      await writeBytes(join(dir, assetPath), bytes);
      await writeJson(join(dir, PUSHED_AT), { at: Date.now() });
    },

    async read(project, commit, assetPath) {
      assertSafeName(project, "project");
      assertSafeName(commit, "commit");
      assertSafeAssetPath(assetPath);
      return readBytesOrNull(join(sourceMapCommitDir(root, project, commit), assetPath));
    },

    async list(project, commit) {
      assertSafeName(project, "project");
      assertSafeName(commit, "commit");
      const files = await listFilesRecursive(sourceMapCommitDir(root, project, commit));
      return files.filter((file) => file !== PUSHED_AT);
    },

    async listCommits(project) {
      assertSafeName(project, "project");
      const dir = sourceMapProjectDir(root, project);
      const commits = await listSubdirsOrEmpty(dir);
      const stamped = await Promise.all(
        commits.map(async (commit) => ({
          commit,
          // Written by every put, so a re-push of an existing commit moves it
          // back to the front. A directory's own mtime would not: it only
          // advances when a direct child appears, and the first one already has.
          at: (await readJson<{ at: number }>(join(dir, commit, PUSHED_AT)).catch(() => null))?.at ?? 0,
        })),
      );
      return stamped.sort((a, b) => b.at - a.at).map((entry) => entry.commit);
    },

    async delete(project, commit) {
      assertSafeName(project, "project");
      assertSafeName(commit, "commit");
      await removePath(sourceMapCommitDir(root, project, commit));
    },
  };
}
