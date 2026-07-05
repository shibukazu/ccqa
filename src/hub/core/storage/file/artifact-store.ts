import { cp } from "node:fs/promises";
import { join } from "node:path";
import { packFilesToTarGz } from "../../tar.ts";
import type { ArtifactStore } from "../types.ts";
import { listFilesRecursive, readBytesOrNull } from "./fs-helpers.ts";
import { artifactsRunDir } from "./paths.ts";

/**
 * Defense-in-depth: `relPath` is expected to already be validated by the
 * HTTP layer (`requireSafeRelPath`), but this store joins it onto a root dir
 * directly, so it re-checks rather than trusting callers blindly.
 */
function assertSafeRelPath(relPath: string): void {
  const segments = relPath.split("/");
  if (
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    relPath.startsWith("\\") ||
    relPath.includes("\\") ||
    segments.includes("..") ||
    segments.includes(".")
  ) {
    throw new Error("invalid artifact path: must be a relative path without '.' or '..' segments");
  }
}

export function createFileArtifactStore(root: string): ArtifactStore {
  return {
    async putDir(runId, srcDir) {
      const dest = artifactsRunDir(root, runId);
      await cp(srcDir, dest, { recursive: true });
    },

    async read(runId, relPath) {
      assertSafeRelPath(relPath);
      return readBytesOrNull(join(artifactsRunDir(root, runId), relPath));
    },

    async readTarGz(runId) {
      const dir = artifactsRunDir(root, runId);
      const files = await listFilesRecursive(dir);
      if (files.length === 0) return null;
      return packFilesToTarGz(dir, files);
    },

    async listFiles(runId) {
      return listFilesRecursive(artifactsRunDir(root, runId));
    },
  };
}
