import type { SecretScope, SecretStore } from "../types.ts";
import { listDirOrEmpty, listSubdirsOrEmpty, readBytesOrNull, readJson, removePath, writeBytes, writeJson } from "./fs-helpers.ts";
import { secretBlobPath, secretKindDir, secretMetaPath, secretProjectDir, secretScopeDir } from "./paths.ts";

interface StoredMeta {
  meta: Record<string, unknown>;
  updatedAt: string;
}

/**
 * Defense-in-depth: project/profile/name are expected to already be validated
 * by the HTTP layer (`requireSafeSegment`), but this store builds file paths
 * directly from them, so it re-checks rather than trusting callers blindly.
 */
function assertSafeName(value: string, label: string): void {
  if (value.length === 0 || value.includes("/") || value.includes("\\") || value.split(/[\\/]/).includes("..") || value === ".") {
    throw new Error(`invalid ${label}: must be a bare name without path separators or '..'`);
  }
}

function assertSafeScope(scope: SecretScope): void {
  assertSafeName(scope.project, "project");
  assertSafeName(scope.profile, "profile");
}

/** Shared implementation behind both the sessions and variables stores — same shape, different kind namespace. */
export function createFileSecretStore(root: string, kind: "sessions" | "variables"): SecretStore {
  return {
    async put(scope, name, blob, meta = {}) {
      assertSafeScope(scope);
      assertSafeName(name, "name");
      // Meta before blob: listings key off `.bin` files, so a crash between
      // the two writes leaves an invisible meta orphan — never a value whose
      // `sensitive` flag was lost (which would fail open and expose it).
      await writeJson(secretMetaPath(root, kind, scope, name), {
        meta,
        updatedAt: new Date().toISOString(),
      } satisfies StoredMeta);
      await writeBytes(secretBlobPath(root, kind, scope, name), blob);
    },

    async get(scope, name) {
      assertSafeScope(scope);
      assertSafeName(name, "name");
      const blob = await readBytesOrNull(secretBlobPath(root, kind, scope, name));
      if (!blob) return null;
      const stored = await readJson<StoredMeta>(secretMetaPath(root, kind, scope, name));
      return { blob, meta: stored?.meta ?? {} };
    },

    async list(scope) {
      assertSafeScope(scope);
      const files = await listDirOrEmpty(secretScopeDir(root, kind, scope));
      const names = files
        .filter((f) => f.endsWith(".bin"))
        .map((f) => f.slice(0, -".bin".length));
      const out: { name: string; meta: Record<string, unknown>; updatedAt: string }[] = [];
      for (const name of names) {
        const stored = await readJson<StoredMeta>(secretMetaPath(root, kind, scope, name));
        out.push({ name, meta: stored?.meta ?? {}, updatedAt: stored?.updatedAt ?? "" });
      }
      return out;
    },

    async delete(scope, name) {
      assertSafeScope(scope);
      assertSafeName(name, "name");
      await removePath(secretBlobPath(root, kind, scope, name));
      await removePath(secretMetaPath(root, kind, scope, name));
    },

    async listProjects() {
      // `<root>/<kind>/` holds one directory per project.
      return (await listSubdirsOrEmpty(secretKindDir(root, kind))).sort();
    },

    async listProfiles(project) {
      // `<root>/<kind>/<project>/` holds one directory per profile.
      return (await listSubdirsOrEmpty(secretProjectDir(root, kind, project))).sort();
    },
  };
}
